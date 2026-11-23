# The CalculiX side of bench/thval.bench.ts (FRS-thermal NFR-TH-021). Offline only, never shipped.
# Reads a case (bodies as unions of boxes with a conductivity and a heat power, cooling conditions picked by
# selectors), builds it in Gmsh with shared faces where bodies touch (perfect contact), meshes it with
# second-order tetrahedra, solves the steady heat conduction with CalculiX (`ccx`) and writes: each body's
# closed surface and each surface's triangles (so the MöbiusCAD side solves the same faces), and the
# temperature at every corner node.
import json, math, os, subprocess, sys
import gmsh
import numpy as np

job = json.load(open(sys.argv[1]))
work, name = job["work"], job["id"]
gmsh.initialize()
gmsh.option.setNumber("General.Terminal", 0)
occ = gmsh.model.occ
groups = []
for b in job["bodies"]:
    tags = [(3, occ.addBox(*bx)) for bx in b["boxes"]]
    if len(tags) > 1:
        tags, _ = occ.fuse(tags[:1], tags[1:])
    groups.append(tags)
allv = [t for g in groups for t in g]
_, out_map = occ.fragment(allv, [])
occ.synchronize()
vols = []  # body index → volume tags after the fragment
k = 0
for g in groups:
    vs = []
    for _ in g:
        vs += [t for _, t in out_map[k]]
        k += 1
    vols.append(sorted(set(vs)))
owner = {v: i for i, vs in enumerate(vols) for v in vs}

gmsh.option.setNumber("Mesh.MeshSizeMax", job["size"])
gmsh.option.setNumber("Mesh.MeshSizeMin", job["size"] / 3)
gmsh.option.setNumber("Mesh.ElementOrder", 2)
gmsh.model.mesh.generate(3)
tags, xyz, _ = gmsh.model.mesh.getNodes()
xyz = xyz.reshape(-1, 3)
idx = {int(t): i for i, t in enumerate(tags)}

elems, ebody = [], []
for v in sorted(owner):
    et, _, en = gmsh.model.mesh.getElements(3, v)
    for t, n in zip(et, en):
        if t != 11: continue
        a = np.array([idx[int(q)] for q in n]).reshape(-1, 10)[:, [0, 1, 2, 3, 4, 5, 6, 7, 9, 8]]
        elems.append(a); ebody += [owner[v]] * len(a)
tets = np.vstack(elems); ebody = np.array(ebody)
# C3D10 faces by their corner nodes: 1 = (1 2 3), 2 = (1 4 2), 3 = (2 4 3), 4 = (3 4 1)
FACES = [(0, 1, 2), (0, 3, 1), (1, 3, 2), (2, 3, 0)]
facemap = {}
for e, t in enumerate(tets):
    for f, (a, b, c) in enumerate(FACES):
        facemap.setdefault(frozenset((t[a], t[b], t[c])), []).append((e, f + 1))

# surfaces: which bodies they bound, their triangles wound out of the first body, centre, normal, area
surfs = []
for _, s in gmsh.model.getEntities(2):
    up, _ = gmsh.model.getAdjacencies(2, s)
    bodies = sorted(set(owner[v] for v in up if v in owner))
    et, _, en = gmsh.model.mesh.getElements(2, s)
    tri = None
    for t, n in zip(et, en):
        if t == 9: tri = np.array([idx[int(q)] for q in n]).reshape(-1, 6)[:, :3]
    if tri is None: continue
    p = xyz[tri]
    cr = np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0])
    area = np.linalg.norm(cr, axis=1).sum() / 2
    n = cr.sum(axis=0); n /= np.linalg.norm(n)
    c = (p.mean(axis=1) * (np.linalg.norm(cr, axis=1) / 2)[:, None]).sum(axis=0) / area
    # outward of the first body: a point a little along the normal must be outside it
    eps = 1e-3 * job["size"]
    inside = any(gmsh.model.isInside(3, v, list(c + eps * n)) for v in vols[bodies[0]])
    if inside: tri = tri[:, [0, 2, 1]]; n = -n
    surfs.append({"id": s, "bodies": bodies, "tri": tri, "c": c.tolist(), "n": n.tolist(), "area": float(area)})
gmsh.finalize()

def pick(sel):
    out = []
    for s in surfs:
        if sel.get("exterior") and len(s["bodies"]) != 1: continue
        if "body" in sel and sel["body"] not in s["bodies"]: continue
        if "normal" in sel and np.dot(s["n"], sel["normal"]) < 0.999: continue
        if "at" in sel and abs(s["c"][sel["at"][0]] - sel["at"][1]) > 1e-6: continue
        out.append(s)
    return out

taken, sinks = set(), []
for c in job["sinks"]:
    got = [s for s in pick(c["sel"]) if s["id"] not in taken]
    if not got: raise SystemExit(f"{name}: no surface for {c}")
    taken.update(s["id"] for s in got)
    sinks.append(got)  # "insul": taken, nothing written (no heat crosses)

inp = os.path.join(work, name + ".inp")
with open(inp, "w") as f:
    f.write("*NODE, NSET=NALL\n")
    for i, q in enumerate(xyz): f.write(f"{i + 1}, {q[0]:.12g}, {q[1]:.12g}, {q[2]:.12g}\n")
    for b in range(len(job["bodies"])):
        f.write(f"*ELEMENT, TYPE=C3D10, ELSET=B{b}\n")
        for e in np.nonzero(ebody == b)[0]: f.write(f"{e + 1}, " + ", ".join(str(v + 1) for v in tets[e]) + "\n")
    for b, bd in enumerate(job["bodies"]):
        f.write(f"*MATERIAL, NAME=M{b}\n*CONDUCTIVITY\n{bd['k'] / 1000:.12g}\n*DENSITY\n1e-9\n*SPECIFIC HEAT\n1e9\n*SOLID SECTION, ELSET=B{b}, MATERIAL=M{b}\n")
    f.write(f"*INITIAL CONDITIONS, TYPE=TEMPERATURE\nNALL, {job['ambient']}\n*STEP\n*HEAT TRANSFER, STEADY STATE\n")
    fixed = {}
    for c, got in zip(job["sinks"], sinks):
        if c["kind"] == "temp":
            for s in got:
                for v in set(s["tri"].ravel().tolist()): fixed[v] = c["T"]
    if fixed:
        # every node of the held faces, mid-side nodes too
        held = set()
        for c, got in zip(job["sinks"], sinks):
            if c["kind"] != "temp": continue
            for s in got:
                for t in s["tri"]:
                    for e, fc in facemap[frozenset(t.tolist())]:
                        a, b, cc = FACES[fc - 1]
                        mids = {(0, 1): 4, (1, 2): 5, (0, 2): 6, (0, 3): 7, (1, 3): 8, (2, 3): 9}
                        nodes = [tets[e][a], tets[e][b], tets[e][cc]] + [tets[e][mids[tuple(sorted(pq))]] for pq in ((a, b), (b, cc), (a, cc))]
                        for v in nodes: held.add((v, c["T"]))
        f.write("*BOUNDARY\n" + "".join(f"{v + 1}, 11, 11, {T}\n" for v, T in sorted(held)))
    films = [(c, got) for c, got in zip(job["sinks"], sinks) if c["kind"] == "conv"]
    if films:
        f.write("*FILM\n")
        for c, got in films:
            for s in got:
                for t in s["tri"]:
                    hits = facemap[frozenset(t.tolist())]
                    if len(hits) != 1: raise SystemExit(f"{name}: a cooled triangle lies on {len(hits)} elements")
                    e, fc = hits[0]
                    f.write(f"{e + 1}, F{fc}, {c['T']}, {c['h'] * 1e-6:.12g}\n")
    srcs = [(b, bd) for b, bd in enumerate(job["bodies"]) if bd.get("power")]
    if srcs:
        f.write("*DFLUX\n")
        for b, bd in srcs:
            p = xyz[tets[ebody == b][:, :4]]
            vol = np.abs(np.einsum("ij,ij->i", np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0]), p[:, 3] - p[:, 0])).sum() / 6
            f.write(f"B{b}, BF, {bd['power'] / vol:.12g}\n")
    f.write("*NODE PRINT, NSET=NALL\nNT\n*END STEP\n")
env = dict(os.environ, OMP_NUM_THREADS=str(os.cpu_count() or 2))
r = subprocess.run(["ccx", name], cwd=work, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
if r.returncode or "Job finished" not in r.stdout: raise SystemExit(f"{name}: ccx failed\n{r.stdout[-2000:]}")
T = np.full(len(xyz), np.nan)
mode = False
for line in open(os.path.join(work, name + ".dat")):
    s = line.split()
    if not s: continue
    if s[0] == "temperatures": mode = True; continue
    try: v = [float(x) for x in s]
    except ValueError: mode = False; continue
    if mode and len(v) == 2: T[int(v[0]) - 1] = v[1]
corner = sorted(set(tets[:, :4].ravel().tolist()))
nb = np.zeros(len(xyz), dtype=int)
for j in range(4): nb[tets[:, j]] = ebody
if np.isnan(T[corner]).any(): raise SystemExit(f"{name}: temperatures missing")
bodyTris = [[] for _ in job["bodies"]]
for s in surfs:
    for i, b in enumerate(s["bodies"]):
        t = s["tri"] if i == 0 else s["tri"][:, [0, 2, 1]]
        bodyTris[b].append(xyz[t].ravel())
json.dump({
    "nodes": len(xyz), "elements": len(tets),
    "bodies": [np.concatenate(t).tolist() for t in bodyTris],
    "sinks": [[xyz[s["tri"]].ravel().tolist() for s in got] for got in sinks],
    "pos": xyz[corner].ravel().tolist(), "body": nb[corner].tolist(), "T": T[corner].tolist(),
}, open(job["out"], "w"))
print(f"{name}: CalculiX {len(xyz)} nodes, {len(tets)} elements, {np.nanmin(T):.3f} .. {np.nanmax(T):.3f} °C")
