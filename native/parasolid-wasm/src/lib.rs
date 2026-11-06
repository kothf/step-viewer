//! Parasolid X_B / X_T reader for MöbiusCAD.
//!
//! parasolid-core (from parasolid-kit, MIT AND Apache-2.0) parses the transmit
//! file and maps it to a Parasolid-native B-rep; this crate only flattens that
//! model to JSON so the browser can rebuild it with OpenCASCADE. No
//! wasm-bindgen: the host calls `ps_alloc`, copies the bytes in, calls
//! `ps_parse` and reads `ps_result_len` bytes of UTF-8 JSON at the returned
//! pointer. Lengths stay in Parasolid units (metres).

use parasolid_core::brep::*;

use parasolid_core::{
    BuiltinProfileRegistry, DocumentLimits, InspectionLimits, SchemaKey, inspect_xb, inspect_xt, parse_xb, parse_xt,
};
use std::fmt::Write;

static mut RESULT: Vec<u8> = Vec::new();

#[unsafe(no_mangle)]
pub extern "C" fn ps_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len.max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `ptr` must come from `ps_alloc(len)`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ps_free(ptr: *mut u8, len: usize) {
    unsafe { drop(Vec::from_raw_parts(ptr, 0, len.max(1))) };
}

/// # Safety
/// `ptr` must point to `len` readable bytes from `ps_alloc`.
#[unsafe(no_mangle)]
#[allow(static_mut_refs)]
pub unsafe extern "C" fn ps_parse(ptr: *const u8, len: usize) -> *const u8 {
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    let json = match parse_to_json(bytes) {
        Ok(s) => s,
        Err(e) => {
            let mut s = String::from("{\"ok\":false,\"error\":");
            str_json(&mut s, &e);
            s.push('}');
            s
        }
    };
    unsafe {
        RESULT = json.into_bytes();
        RESULT.as_ptr()
    }
}

#[unsafe(no_mangle)]
#[allow(static_mut_refs)]
pub extern "C" fn ps_result_len() -> usize {
    unsafe { RESULT.len() }
}

/// Parses an X_B (binary, starts with `PS`) or X_T (text) transmit file to the JSON B-rep.
pub fn parse_to_json(bytes: &[u8]) -> Result<String, String> {
    let registry = BuiltinProfileRegistry::compiled().map_err(|e| e.to_string())?;
    let text = !bytes.starts_with(b"PS");
    let model = if text {
        let header = inspect_xt(bytes, InspectionLimits::default()).map_err(|e| e.to_string())?;
        let key = SchemaKey::parse(&header.schema_key).map_err(|e| e.to_string())?;
        let provider = registry
            .provider_for_key(&key)
            .ok_or_else(|| format!("unsupported Parasolid schema {}", header.schema_key))?;
        let doc = parse_xt(bytes, &provider, DocumentLimits::default()).map_err(|e| e.to_string())?;
        map_xt_brep(&doc).map_err(|e| e.to_string())?
    } else {
        let header = inspect_xb(bytes, InspectionLimits::default()).map_err(|e| e.to_string())?;
        let key = SchemaKey::parse(&header.schema_key).map_err(|e| e.to_string())?;
        let provider = registry
            .provider_for_key(&key)
            .ok_or_else(|| format!("unsupported Parasolid schema {}", header.schema_key))?;
        let doc = parse_xb(bytes, &provider, DocumentLimits::default()).map_err(|e| e.to_string())?;
        map_xb_brep(&doc).map_err(|e| e.to_string())?
    };
    Ok(model_json(&model))
}

// ---------- JSON ----------

fn str_json(s: &mut String, v: &str) {
    s.push('"');
    for c in v.chars() {
        match c {
            '"' => s.push_str("\\\""),
            '\\' => s.push_str("\\\\"),
            c if (c as u32) < 0x20 => {
                let _ = write!(s, "\\u{:04x}", c as u32);
            }
            c => s.push(c),
        }
    }
    s.push('"');
}

fn num(s: &mut String, v: f64) {
    if v.is_finite() {
        let _ = write!(s, "{v}");
    } else {
        s.push_str("null");
    }
}

fn v3(s: &mut String, v: &Vector3) {
    s.push('[');
    num(s, v.x);
    s.push(',');
    num(s, v.y);
    s.push(',');
    num(s, v.z);
    s.push(']');
}

fn opt_id(s: &mut String, v: Option<BrepId>) {
    match v {
        Some(id) => {
            let _ = write!(s, "{id}");
        }
        None => s.push_str("null"),
    }
}

fn ids(s: &mut String, v: &[BrepId]) {
    s.push('[');
    for (i, id) in v.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        let _ = write!(s, "{id}");
    }
    s.push(']');
}

fn nums(s: &mut String, v: &[f64]) {
    s.push('[');
    for (i, x) in v.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        num(s, *x);
    }
    s.push(']');
}

fn ints<T: std::fmt::Display>(s: &mut String, v: &[T]) {
    s.push('[');
    for (i, x) in v.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        let _ = write!(s, "{x}");
    }
    s.push(']');
}

fn sense(v: Sense) -> i32 {
    match v {
        Sense::Positive => 1,
        Sense::Negative => -1,
        Sense::Unknown => 0,
    }
}

/// Comma between array items.
struct List(bool);
impl List {
    fn sep(&mut self, s: &mut String) {
        if self.0 {
            s.push(',');
        }
        self.0 = true;
    }
}

fn model_json(m: &BrepModel) -> String {
    let mut s = String::with_capacity(1 << 16);
    s.push_str("{\"ok\":true,\"key\":");
    str_json(&mut s, &m.schema_key);
    let _ = write!(s, ",\"complete\":{}", m.complete);

    s.push_str(",\"diagnostics\":[");
    let mut l = List(false);
    for d in m.diagnostics.iter().take(50) {
        l.sep(&mut s);
        s.push_str("{\"code\":");
        str_json(&mut s, d.code);
        s.push_str(",\"message\":");
        str_json(&mut s, &d.message);
        s.push('}');
    }

    s.push_str("],\"bodies\":[");
    let mut l = List(false);
    for b in &m.bodies {
        l.sep(&mut s);
        let _ = write!(s, "{{\"id\":{},\"res\":", b.id);
        num(&mut s, b.linear_resolution);
        s.push_str(",\"regions\":");
        ids(&mut s, &b.regions);
        s.push('}');
    }

    s.push_str("],\"regions\":[");
    let mut l = List(false);
    for r in &m.regions {
        l.sep(&mut s);
        let _ = write!(s, "{{\"id\":{},\"body\":{},\"solid\":{},\"shells\":", r.id, r.body, r.kind == RegionKind::Solid);
        ids(&mut s, &r.shells);
        s.push('}');
    }

    s.push_str("],\"shells\":[");
    let mut l = List(false);
    for sh in &m.shells {
        l.sep(&mut s);
        let _ = write!(s, "{{\"id\":{},\"region\":{},\"front\":", sh.id, sh.region);
        ids(&mut s, &sh.front_faces);
        s.push_str(",\"back\":");
        ids(&mut s, &sh.back_faces);
        s.push_str(",\"wires\":");
        ids(&mut s, &sh.wire_edges);
        s.push('}');
    }

    s.push_str("],\"faces\":[");
    let mut l = List(false);
    for f in &m.faces {
        l.sep(&mut s);
        let _ = write!(
            s,
            "{{\"id\":{},\"front\":{},\"back\":{},\"sense\":{},\"surface\":",
            f.id,
            f.front_shell,
            f.back_shell,
            sense(f.sense)
        );
        opt_id(&mut s, f.surface);
        s.push_str(",\"loops\":");
        ids(&mut s, &f.loops);
        s.push('}');
    }

    s.push_str("],\"loops\":[");
    let mut l = List(false);
    for lp in &m.loops {
        l.sep(&mut s);
        let _ = write!(s, "{{\"id\":{},\"face\":{},\"fins\":", lp.id, lp.face);
        ids(&mut s, &lp.half_edges);
        s.push('}');
    }

    s.push_str("],\"fins\":[");
    let mut l = List(false);
    for h in &m.half_edges {
        l.sep(&mut s);
        let _ = write!(s, "{{\"id\":{},\"sense\":{},\"dummy\":{},\"loop\":", h.id, sense(h.sense), h.dummy);
        opt_id(&mut s, h.loop_id);
        s.push_str(",\"edge\":");
        opt_id(&mut s, h.edge);
        s.push_str(",\"vertex\":");
        opt_id(&mut s, h.vertex);
        s.push_str(",\"curve\":");
        opt_id(&mut s, h.curve);
        s.push_str(",\"other\":");
        opt_id(&mut s, h.other);
        s.push_str(",\"next\":");
        opt_id(&mut s, h.forward);
        s.push('}');
    }

    s.push_str("],\"edges\":[");
    let mut l = List(false);
    for e in &m.edges {
        l.sep(&mut s);
        let _ = write!(s, "{{\"id\":{},\"start\":", e.id);
        opt_id(&mut s, e.start_vertex);
        s.push_str(",\"end\":");
        opt_id(&mut s, e.end_vertex);
        s.push_str(",\"curve\":");
        opt_id(&mut s, e.curve);
        s.push_str(",\"tol\":");
        match e.tolerance {
            Some(t) => num(&mut s, t),
            None => s.push_str("null"),
        }
        s.push_str(",\"fins\":");
        ids(&mut s, &e.half_edges);
        s.push('}');
    }

    s.push_str("],\"vertices\":[");
    let mut l = List(false);
    for v in &m.vertices {
        l.sep(&mut s);
        let _ = write!(s, "{{\"id\":{},\"p\":", v.id);
        match m.points.iter().find(|p| p.id == v.point) {
            Some(p) => v3(&mut s, &p.position),
            None => s.push_str("null"),
        }
        s.push_str(",\"tol\":");
        match v.tolerance {
            Some(t) => num(&mut s, t),
            None => s.push_str("null"),
        }
        s.push('}');
    }

    s.push_str("],\"curves\":[");
    let mut l = List(false);
    for c in &m.curves {
        l.sep(&mut s);
        let _ = write!(s, "{{\"id\":{},\"sense\":{},\"t\":", c.id, sense(c.sense));
        str_json(&mut s, c.kind.as_str());
        curve_json(&mut s, &c.kind);
        s.push('}');
    }

    s.push_str("],\"surfaces\":[");
    let mut l = List(false);
    for g in &m.surfaces {
        l.sep(&mut s);
        let _ = write!(s, "{{\"id\":{},\"sense\":{},\"t\":", g.id, sense(g.sense));
        str_json(&mut s, g.kind.as_str());
        surface_json(&mut s, &g.kind);
        s.push('}');
    }

    s.push_str("],\"attributes\":[");
    let mut l = List(false);
    for a in &m.attributes {
        let Some(owner) = a.owner.id() else { continue };
        l.sep(&mut s);
        s.push_str("{\"name\":");
        str_json(&mut s, &a.identifier);
        s.push_str(",\"owner\":");
        str_json(&mut s, a.owner.kind());
        let _ = write!(s, ",\"of\":{owner},\"reals\":[");
        let mut lr = List(false);
        for f in &a.fields {
            if let AttributeField::Reals(r) = f {
                for x in r {
                    lr.sep(&mut s);
                    match x {
                        Some(x) => num(&mut s, *x),
                        None => s.push_str("null"),
                    }
                }
            }
        }
        s.push_str("],\"text\":");
        let text = a.fields.iter().find_map(|f| match f {
            AttributeField::Text(t) | AttributeField::Unicode(t) => Some(t.as_str()),
            _ => None,
        });
        match text {
            Some(t) => str_json(&mut s, t),
            None => s.push_str("null"),
        }
        s.push('}');
    }

    s.push_str("],\"assemblies\":[");
    let mut l = List(false);
    for a in &m.assemblies {
        l.sep(&mut s);
        let _ = write!(s, "{{\"id\":{},\"instances\":", a.id);
        ids(&mut s, &a.instances);
        s.push('}');
    }

    s.push_str("],\"instances\":[");
    let mut l = List(false);
    for i in &m.instances {
        l.sep(&mut s);
        let (kind, part) = match i.part {
            InstancePart::Body(b) => ("body", b),
            InstancePart::Assembly(a) => ("assembly", a),
        };
        let _ = write!(s, "{{\"id\":{},\"assembly\":{},\"kind\":\"{kind}\",\"part\":{part},\"transform\":", i.id, i.assembly);
        match &i.transform {
            Some(t) => {
                s.push_str("{\"rotation\":[");
                for (k, row) in t.rotation.iter().enumerate() {
                    if k > 0 {
                        s.push(',');
                    }
                    nums(&mut s, row);
                }
                s.push_str("],\"translation\":");
                v3(&mut s, &t.translation);
                s.push_str(",\"scale\":");
                num(&mut s, t.scale);
                s.push('}');
            }
            None => s.push_str("null"),
        }
        s.push('}');
    }
    s.push_str("]}");
    s
}

fn key_v3(s: &mut String, k: &str, v: &Vector3) {
    let _ = write!(s, ",\"{k}\":");
    v3(s, v);
}

fn key_num(s: &mut String, k: &str, v: f64) {
    let _ = write!(s, ",\"{k}\":");
    num(s, v);
}

fn key_id(s: &mut String, k: &str, v: BrepId) {
    let _ = write!(s, ",\"{k}\":{v}");
}

fn nurbs_curve(s: &mut String, n: &NurbsCurve) {
    let _ = write!(
        s,
        ",\"degree\":{},\"dim\":{},\"periodic\":{},\"closed\":{},\"rational\":{},\"cv\":",
        n.degree, n.vertex_dimension, n.periodic, n.closed, n.rational
    );
    let flat: Vec<f64> = n.control_vertices.iter().flatten().copied().collect();
    nums(s, &flat);
    s.push_str(",\"knots\":");
    nums(s, &n.knots);
    s.push_str(",\"mults\":");
    ints(s, &n.knot_multiplicities);
}

fn curve_json(s: &mut String, k: &CurveKind) {
    match k {
        CurveKind::Line { point, direction } => {
            key_v3(s, "point", point);
            key_v3(s, "dir", direction);
        }
        CurveKind::Circle { center, normal, x_axis, radius } => {
            key_v3(s, "center", center);
            key_v3(s, "normal", normal);
            key_v3(s, "x", x_axis);
            key_num(s, "r", *radius);
        }
        CurveKind::Ellipse { center, normal, x_axis, major_radius, minor_radius } => {
            key_v3(s, "center", center);
            key_v3(s, "normal", normal);
            key_v3(s, "x", x_axis);
            key_num(s, "r1", *major_radius);
            key_num(s, "r2", *minor_radius);
        }
        CurveKind::Parabola { origin, normal, x_axis, focal_length } => {
            key_v3(s, "center", origin);
            key_v3(s, "normal", normal);
            key_v3(s, "x", x_axis);
            key_num(s, "f", *focal_length);
        }
        CurveKind::Hyperbola { origin, normal, x_axis, transverse_radius, conjugate_radius } => {
            key_v3(s, "center", origin);
            key_v3(s, "normal", normal);
            key_v3(s, "x", x_axis);
            key_num(s, "r1", *transverse_radius);
            key_num(s, "r2", *conjugate_radius);
        }
        CurveKind::Trimmed { basis_curve, start_point, end_point, start_parameter, end_parameter } => {
            key_id(s, "basis", *basis_curve);
            key_v3(s, "p0", start_point);
            key_v3(s, "p1", end_point);
            key_num(s, "t0", *start_parameter);
            key_num(s, "t1", *end_parameter);
        }
        CurveKind::Nurbs(n) => nurbs_curve(s, n),
        CurveKind::SurfaceParametric { surface, parameter_curve, original_curve, .. } => {
            key_id(s, "surface", *surface);
            key_id(s, "pcurve", *parameter_curve);
            s.push_str(",\"original\":");
            opt_id(s, *original_curve);
        }
        CurveKind::Intersection { surfaces, chart_points, start_points, end_points, .. } => {
            let _ = write!(s, ",\"surfaces\":[{},{}],\"chart\":[", surfaces[0], surfaces[1]);
            for (i, p) in chart_points.iter().enumerate() {
                if i > 0 {
                    s.push(',');
                }
                v3(s, p);
            }
            s.push_str("],\"start\":");
            match start_points.first() {
                Some(p) => v3(s, p),
                None => s.push_str("null"),
            }
            s.push_str(",\"end\":");
            match end_points.first() {
                Some(p) => v3(s, p),
                None => s.push_str("null"),
            }
        }
        CurveKind::Unsupported { type_name } => {
            s.push_str(",\"name\":");
            str_json(s, type_name);
        }
    }
}

fn surface_json(s: &mut String, k: &SurfaceKind) {
    match k {
        SurfaceKind::Plane { point, normal, x_axis } => {
            key_v3(s, "point", point);
            key_v3(s, "normal", normal);
            key_v3(s, "x", x_axis);
        }
        SurfaceKind::Cylinder { point, axis, radius, x_axis } => {
            key_v3(s, "point", point);
            key_v3(s, "axis", axis);
            key_v3(s, "x", x_axis);
            key_num(s, "r", *radius);
        }
        SurfaceKind::Cone { point, axis, radius, sin_half_angle, cos_half_angle, x_axis } => {
            key_v3(s, "point", point);
            key_v3(s, "axis", axis);
            key_v3(s, "x", x_axis);
            key_num(s, "r", *radius);
            key_num(s, "sin", *sin_half_angle);
            key_num(s, "cos", *cos_half_angle);
        }
        SurfaceKind::Sphere { center, radius, axis, x_axis } => {
            key_v3(s, "point", center);
            key_v3(s, "axis", axis);
            key_v3(s, "x", x_axis);
            key_num(s, "r", *radius);
        }
        SurfaceKind::Torus { center, axis, major_radius, minor_radius, x_axis } => {
            key_v3(s, "point", center);
            key_v3(s, "axis", axis);
            key_v3(s, "x", x_axis);
            key_num(s, "r1", *major_radius);
            key_num(s, "r2", *minor_radius);
        }
        SurfaceKind::BlendedEdge { blend_type, supporting_surfaces, spine_curve, ranges, .. } => {
            let _ = write!(
                s,
                ",\"blend\":\"{}\",\"supports\":[{},{}],\"spine\":{}",
                blend_type.as_str(),
                supporting_surfaces[0],
                supporting_surfaces[1],
                spine_curve
            );
            s.push_str(",\"ranges\":");
            nums(s, ranges);
        }
        SurfaceKind::BlendBoundary { boundary_index, blend_surface } => {
            let _ = write!(s, ",\"index\":{boundary_index},\"blendSurface\":{blend_surface}");
        }
        SurfaceKind::Spun { profile, base, axis, .. } => {
            key_id(s, "profile", *profile);
            key_v3(s, "point", base);
            key_v3(s, "axis", axis);
        }
        SurfaceKind::Swept { section, direction } => {
            key_id(s, "section", *section);
            key_v3(s, "dir", direction);
        }
        SurfaceKind::Offset { basis_surface, offset } => {
            key_id(s, "basis", *basis_surface);
            key_num(s, "offset", *offset);
        }
        SurfaceKind::Nurbs(n) => {
            let _ = write!(
                s,
                ",\"uDegree\":{},\"vDegree\":{},\"nu\":{},\"nv\":{},\"dim\":{},\"uPeriodic\":{},\"vPeriodic\":{},\"rational\":{},\"cv\":",
                n.u_degree,
                n.v_degree,
                n.u_control_vertex_count,
                n.v_control_vertex_count,
                n.vertex_dimension,
                n.u_periodic,
                n.v_periodic,
                n.rational
            );
            let flat: Vec<f64> = n.control_vertices.iter().flatten().copied().collect();
            nums(s, &flat);
            s.push_str(",\"uKnots\":");
            nums(s, &n.u_knots);
            s.push_str(",\"vKnots\":");
            nums(s, &n.v_knots);
            s.push_str(",\"uMults\":");
            ints(s, &n.u_knot_multiplicities);
            s.push_str(",\"vMults\":");
            ints(s, &n.v_knot_multiplicities);
        }
        SurfaceKind::Unsupported { type_name } => {
            s.push_str(",\"name\":");
            str_json(s, type_name);
        }
    }
}
