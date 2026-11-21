# The CalculiX side of bench/simval.bench.ts (FRS-structural NFR-SIM-022). Offline only, never shipped.
# Reads a job (STEP file, the held and loaded faces by area and centre, the force, the material), meshes the part
# with second-order tetrahedra in Gmsh, solves it with CalculiX (`ccx`) and writes the displacements at the
# corner nodes and the von Mises stress at the integration points.
import json, math, os, subprocess, sys
import gmsh
import numpy as np

job = json.load(open(sys.argv[1]))
work, name = job["work"], job["id"]
gmsh.initialize()
gmsh.option.setNumber("General.Terminal", 0)
gmsh.model.occ.importShapes(job["step"])
gmsh.model.occ.synchronize()
surfs = [t for _, t in gmsh.model.getEntities(2)]
info = {t: (gmsh.model.occ.getMass(2, t), gmsh.model.occ.getCenterOfMass(2, t)) for t in surfs}
box = gmsh.model.getBoundingBox(-1, -1)
diag = math.dist(box[:3], box[3:])

def find(face):
    best, at = None, 1e9
    for t, (a, c) in info.items():
        d = math.dist(c, face["at"]) / diag + abs(a - face["area"]) / max(face["area"], 1e-9)
        if d < at: best, at = t, d
    if at > 0.02: raise SystemExit(f"{name}: no face of the STEP file matches {face} (nearest is off by {at:.3f})")
    return best

fixed = [find(f) for f in job["fixed"]]
loaded = [find(f) for f in job["loaded"]]
gmsh.option.setNumber("Mesh.MeshSizeMax", job["size"])
gmsh.option.setNumber("Mesh.MeshSizeMin", job["size"] / 4)
gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", 24)
gmsh.option.setNumber("Mesh.ElementOrder", 2)
gmsh.option.setNumber("Mesh.HighOrderOptimize", 2)
gmsh.model.mesh.generate(3)
tags, xyz, _ = gmsh.model.mesh.getNodes()
xyz = xyz.reshape(-1, 3)
idx = {int(t): i for i, t in enumerate(tags)}
et, _, en = gmsh.model.mesh.getElements(3)
tets = None
for t, n in zip(et, en):
    if t == 11: tets = np.array([idx[int(v)] for v in n]).reshape(-1, 10)
if tets is None: raise SystemExit(f"{name}: no second-order tetrahedra")
# Gmsh's last two mid-edge nodes are the other way round in CalculiX's C3D10
tets = tets[:, [0, 1, 2, 3, 4, 5, 6, 7, 9, 8]]

def tri6(surf):
    out = []
    for s in surf:
        t, _, n = gmsh.model.mesh.getElements(2, s)
        for tt, nn in zip(t, n):
            if tt == 9: out.append(np.array([idx[int(v)] for v in nn]).reshape(-1, 6))
    return np.vstack(out)

fix_nodes = sorted(set(tri6(fixed).ravel().tolist()))
# a uniform traction on a six-node triangle: nothing on the corners, a third of the triangle's load on each mid-side node
lt = tri6(loaded)
p = xyz[lt[:, :3]]
areas = np.linalg.norm(np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0]), axis=1) / 2
# the flat area of curved triangles is a little short: scale so that the whole force is applied
load = np.zeros((len(xyz), 3))
for tri, a in zip(lt, areas):
    for m in tri[3:]: load[m] += np.array(job["force"]) * a / 3 / areas.sum()
gmsh.finalize()

inp = os.path.join(work, name + ".inp")
with open(inp, "w") as f:
    f.write("*NODE, NSET=NALL\n")
    for i, q in enumerate(xyz): f.write(f"{i + 1}, {q[0]:.12g}, {q[1]:.12g}, {q[2]:.12g}\n")
    f.write("*ELEMENT, TYPE=C3D10, ELSET=EALL\n")
    for i, e in enumerate(tets): f.write(f"{i + 1}, " + ", ".join(str(v + 1) for v in e) + "\n")
    f.write("*NSET, NSET=NFIX\n" + "".join(f"{v + 1},\n" for v in fix_nodes))
    f.write(f"*MATERIAL, NAME=M\n*ELASTIC\n{job['E']}, {job['nu']}\n*SOLID SECTION, ELSET=EALL, MATERIAL=M\n")
    f.write("*BOUNDARY\nNFIX, 1, 3\n*STEP\n*STATIC\n*CLOAD\n")
    for i in np.nonzero(np.abs(load).sum(axis=1))[0]:
        for k in range(3):
            if load[i, k]: f.write(f"{i + 1}, {k + 1}, {load[i, k]:.12g}\n")
    f.write("*NODE PRINT, NSET=NALL\nU\n*NODE PRINT, NSET=NFIX, TOTALS=ONLY\nRF\n*EL PRINT, ELSET=EALL\nS\n*EL PRINT, ELSET=EALL\nCOORD\n*END STEP\n")
env = dict(os.environ, OMP_NUM_THREADS=str(os.cpu_count() or 2))
r = subprocess.run(["ccx", name], cwd=work, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
if r.returncode or "Job finished" not in r.stdout: raise SystemExit(f"{name}: ccx failed\n{r.stdout[-2000:]}")

u = np.zeros((len(xyz), 3)); S, C, RF = [], [], None
mode = None
for line in open(os.path.join(work, name + ".dat")):
    s = line.split()
    if not s: continue
    if s[0] == "displacements": mode = "u"; continue
    if s[0] == "stresses": mode = "s"; continue
    if s[0] == "total" and s[1] == "force": mode = "rf"; continue
    if s[0] == "forces": mode = None; continue
    if s[0] == "global" or s[0] == "coordinates": mode = "c" if "coordinates" in line else mode; continue
    try: v = [float(x) for x in s]
    except ValueError: mode = None; continue
    if mode == "u" and len(v) == 4: u[int(v[0]) - 1] = v[1:]
    elif mode == "s" and len(v) == 8: S.append(v[2:])
    elif mode == "c" and len(v) == 5: C.append(v[2:])
    elif mode == "rf" and len(v) == 3: RF = v
S, C = np.array(S), np.array(C)
if len(S) != 4 * len(tets) or len(C) != len(S): raise SystemExit(f"{name}: read {len(S)} stresses and {len(C)} points for {len(tets)} elements")
vm = np.sqrt(0.5 * ((S[:, 0] - S[:, 1]) ** 2 + (S[:, 1] - S[:, 2]) ** 2 + (S[:, 2] - S[:, 0]) ** 2) + 3 * (S[:, 3] ** 2 + S[:, 4] ** 2 + S[:, 5] ** 2))
# away from the support: farther than a tenth of the part's size from every held node
fx = xyz[fix_nodes]
far = np.ones(len(C), dtype=bool)
for a in range(0, len(C), 4000):
    c = C[a:a + 4000]
    d = np.min(np.linalg.norm(c[:, None, :] - fx[None, ::max(1, len(fx) // 400), :], axis=2), axis=1)
    far[a:a + 4000] = d > 0.1 * diag
corner = sorted(set(tets[:, :4].ravel().tolist()))
json.dump({"nodes": len(xyz), "elements": len(tets), "pos": xyz[corner].ravel().tolist(), "u": u[corner].ravel().tolist(), "ip": C.ravel().tolist(), "vm": vm.tolist(), "far": far.astype(int).tolist(), "reaction": RF}, open(job["out"], "w"))
print(f"{name}: CalculiX {len(xyz)} nodes, {len(tets)} elements, largest displacement {np.linalg.norm(u, axis=1).max():.6g} mm, reaction {RF}")
