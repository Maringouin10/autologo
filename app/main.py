"""Flask app: password login + upload/place/export workflow for AutoLogo,
plus the vendor platform built on top of it — /admin (password-protected,
same login as the plain tool) lets a vendor upload a multi-part assembly,
mark which piece(s)/face(s) customers may put a logo on and with what
print parameters, and publish it; /o/<product_id> (public, no login) is
where a customer places their logo on those pre-approved spots and submits
— for now that just hands them a unique order code."""
from __future__ import annotations

import functools
import hmac
import io
import json
import logging
import os
import shutil
import uuid
from datetime import timedelta

from flask import (Flask, abort, flash, jsonify, redirect, render_template,
                    request, send_file, session, url_for)
from werkzeug.exceptions import HTTPException
from werkzeug.middleware.proxy_fix import ProxyFix

from . import config, db, meshwork as mw, orders, store

_HTML_ENDPOINTS = {"login", "logout", "gallery", "tool", "admin_home", "admin_new_product",
                    "admin_product_detail", "customer_order"}

logging.basicConfig(level=logging.INFO,
                     format="%(asctime)s %(levelname)s %(name)s | %(message)s")
log = logging.getLogger("autologo")

app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)
app.secret_key = config.SECRET_KEY or os.urandom(32)
app.permanent_session_lifetime = timedelta(days=7)
app.config["MAX_CONTENT_LENGTH"] = config.MAX_UPLOAD_MB * 1024 * 1024

config.SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
config.PRODUCTS_DIR.mkdir(parents=True, exist_ok=True)
config.ORDERS_DIR.mkdir(parents=True, exist_ok=True)
db.init_db()
store.start_cleanup_thread()
orders.start_cleanup_thread()
if not config.DASHBOARD_PASSWORD:
    log.warning("DASHBOARD_PASSWORD is empty — login is disabled until you set it!")


def login_required(view):
    @functools.wraps(view)
    def wrapper(*args, **kwargs):
        if config.DASHBOARD_PASSWORD and not session.get("authed"):
            return redirect(url_for("login", next=request.path))
        return view(*args, **kwargs)
    return wrapper


@app.errorhandler(Exception)
def handle_error(exc):
    """Every route except the plain HTML pages is fetch()'d by the
    frontend and expects JSON back — an uncaught exception used to fall
    through to Flask's default HTML error page, which broke the browser's
    `res.json()` with a cryptic "Unexpected token '<'" instead of showing
    the real error.

    For the HTML pages, don't `raise exc` to "hand it back" to Flask —
    once an `errorhandler(Exception)` has caught it, re-raising lands in
    Flask's *outer* exception handling (for errors from error handlers
    themselves), which discards the original status code and reports a
    generic 500 even for a plain 404. `exc.get_response()` is Werkzeug's
    own default error page — calling it directly is what Flask would have
    rendered with no custom handler at all, correct status code included."""
    if request.endpoint in _HTML_ENDPOINTS:
        if isinstance(exc, HTTPException):
            return exc.get_response()
        log.exception("Unhandled error on %s", request.path)
        return "Erreur interne du serveur.", 500
    code = exc.code if isinstance(exc, HTTPException) else 500
    message = exc.description if isinstance(exc, HTTPException) else str(exc)
    if code >= 500:
        log.exception("Unhandled error on %s", request.path)
    return jsonify({"error": message}), code


@app.route("/login", methods=["GET", "POST"])
def login():
    if session.get("authed"):
        return redirect(url_for("admin_home"))
    if request.method == "POST":
        supplied = request.form.get("password", "")
        if config.DASHBOARD_PASSWORD and hmac.compare_digest(supplied, config.DASHBOARD_PASSWORD):
            session.clear()
            session["authed"] = True
            session.permanent = True
            nxt = request.args.get("next")
            if not nxt or not nxt.startswith("/"):
                nxt = url_for("admin_home")
            return redirect(nxt)
        flash("Mot de passe incorrect.")
    return render_template("login.html")


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


# --- public gallery --------------------------------------------------------------
@app.route("/")
def gallery():
    products = []
    for p in db.list_products():
        colors = json.loads(p["colors_json"] or "{}")
        swatch = "#{:02x}{:02x}{:02x}".format(*next(iter(colors.values()))) if colors else "#8fa6c9"
        products.append({"id": p["id"], "name": p["name"], "swatch": swatch})
    return render_template("gallery.html", products=products)


@app.route("/tool")
@login_required
def tool():
    return render_template("index.html")


# --- admin pages ---------------------------------------------------------------
@app.route("/admin")
@login_required
def admin_home():
    return render_template("admin_products.html", products=db.list_products())


@app.route("/admin/products/new")
@login_required
def admin_new_product():
    return render_template("admin_new_product.html")


@app.route("/admin/products/<product_id>")
@login_required
def admin_product_detail(product_id):
    product = db.get_product(product_id)
    if product is None:
        abort(404, "produit introuvable")
    return render_template(
        "admin_product_detail.html", product=product,
        zones=db.list_zones(product_id), orders=db.list_orders(product_id),
        customer_url=url_for("customer_order", product_id=product_id, _external=True),
    )


@app.route("/admin/products/<product_id>/delete", methods=["POST"])
@login_required
def admin_delete_product(product_id):
    db.delete_product(product_id)
    shutil.rmtree(config.PRODUCTS_DIR / product_id, ignore_errors=True)
    return redirect(url_for("admin_home"))


@app.route("/admin/orders/<code>/download")
@login_required
def admin_download_order(code):
    order = db.get_order(code)
    if order is None or not order["output_path"] or not os.path.exists(order["output_path"]):
        abort(404, "commande introuvable")
    return send_file(order["output_path"], mimetype="model/3mf",
                      as_attachment=True, download_name=f"commande_{code}.3mf")


# --- customer page ---------------------------------------------------------------
@app.route("/o/<product_id>")
def customer_order(product_id):
    product = db.get_product(product_id)
    if product is None:
        abort(404, "produit introuvable ou lien invalide")
    zones = db.list_zones(product_id)
    if not zones:
        abort(404, "ce produit n'est pas encore prêt (aucune zone configurée)")
    return render_template("order.html", product=product)


# --- helpers -----------------------------------------------------------------
def _require_session(session_id: str) -> store.Session:
    sess = store.get(session_id)
    if sess is None:
        abort(404, "session introuvable ou expirée")
    return sess


def _err(exc: Exception, code: int = 400):
    return jsonify({"error": str(exc)}), code


def _placement_params(data: dict) -> mw.PlacementParams:
    return mw.PlacementParams(
        width_mm=max(1.0, float(data.get("width_mm", 20.0))),
        rotation_deg=float(data.get("rotation_deg", 0.0)) % 360.0,
        offset_x_mm=float(data.get("offset_x_mm", 0.0)),
        offset_y_mm=float(data.get("offset_y_mm", 0.0)),
    )


def _mesh_to_glb_response(mesh):
    data = mw.to_glb(mesh)
    return send_file(io.BytesIO(data), mimetype="model/gltf-binary",
                      as_attachment=False, download_name="preview.glb",
                      max_age=0)


# --- uploads -------------------------------------------------------------------
@app.route("/api/upload/model", methods=["POST"])
@login_required
def upload_model():
    f = request.files.get("file")
    if not f or not f.filename:
        return _err(ValueError("aucun fichier reçu"))
    ext = "." + f.filename.rsplit(".", 1)[-1].lower() if "." in f.filename else ""
    if ext not in config.MODEL_EXTS:
        return _err(ValueError(f"format non supporté ({ext or '?'}) — "
                                f"attendu: {', '.join(sorted(config.MODEL_EXTS))}"))

    sess = store.create()
    sess.model_ext = ext
    f.save(str(sess.model_path))

    try:
        mesh = sess.mesh()
        glb = mw.to_glb(mesh)
        sess.glb_path.write_bytes(glb)
    except mw.MeshError as exc:
        return _err(exc)

    bounds = mesh.bounds
    return jsonify({
        "session_id": sess.id,
        "glb_url": url_for("session_glb", session_id=sess.id),
        "face_count": int(len(mesh.faces)),
        "bounds": {"min": bounds[0].tolist(), "max": bounds[1].tolist()},
        "scale_mm": round(float(mesh.scale), 2),
    })


@app.route("/api/upload/logo", methods=["POST"])
@login_required
def upload_logo():
    session_id = request.form.get("session_id", "")
    sess = _require_session(session_id)
    f = request.files.get("file")
    if not f or not f.filename:
        return _err(ValueError("aucun fichier reçu"))
    if not f.filename.lower().endswith(".svg"):
        return _err(ValueError("le logo doit être un fichier .svg"))

    f.save(str(sess.logo_path))
    sess.invalidate_logo()
    try:
        polygons = sess.logo_polygons()
    except mw.MeshError as exc:
        sess.logo_path.unlink(missing_ok=True)
        return _err(exc)

    minx, miny, maxx, maxy = mw.logo_bounds(polygons)
    return jsonify({
        "ok": True,
        "logo_bounds": {"width": round(float(maxx - minx), 2),
                         "height": round(float(maxy - miny), 2)},
        "shapes": mw.shapes_payload(polygons),
    })


@app.route("/api/session/<session_id>/logo/edit", methods=["POST"])
@login_required
def edit_logo(session_id):
    sess = _require_session(session_id)
    if not sess.logo_path.exists():
        return _err(ValueError("aucun logo importé pour cette session"))
    data = request.get_json(force=True, silent=True) or {}
    try:
        excluded = {int(i) for i in data.get("excluded", [])}
    except (TypeError, ValueError):
        return _err(ValueError("liste d'exclusion invalide"))
    n = len(sess.logo_polygons())
    sess.excluded_shapes = {i for i in excluded if 0 <= i < n}
    sess.flip_h = bool(data.get("flip_h", False))
    sess.flip_v = bool(data.get("flip_v", False))

    try:
        minx, miny, maxx, maxy = mw.logo_bounds(sess.active_logo_polygons())
    except mw.MeshError as exc:
        return _err(exc)
    return jsonify({
        "ok": True,
        "logo_bounds": {"width": round(float(maxx - minx), 2),
                         "height": round(float(maxy - miny), 2)},
    })


@app.route("/api/session/<session_id>/logo/fit", methods=["POST"])
@login_required
def fit_logo(session_id):
    sess = _require_session(session_id)
    if not sess.logo_path.exists():
        return _err(ValueError("aucun logo importé pour cette session"))
    data = request.get_json(force=True, silent=True) or {}
    try:
        face_index = int(data["face_index"])
    except (KeyError, TypeError, ValueError):
        return _err(ValueError("face_index manquant/invalide"))

    try:
        info = mw.find_flat_region(sess.mesh(), sess.face_adjacency(), face_index)
        width_mm, rotation_deg = mw.fit_to_face(sess.active_logo_polygons(), info)
    except mw.MeshError as exc:
        return _err(exc)
    return jsonify({"width_mm": width_mm, "rotation_deg": rotation_deg})


@app.route("/session/<session_id>/model.glb")
@login_required
def session_glb(session_id):
    sess = _require_session(session_id)
    if not sess.glb_path.exists():
        abort(404)
    return send_file(str(sess.glb_path), mimetype="model/gltf-binary", max_age=3600)


# --- face selection ------------------------------------------------------------
@app.route("/api/session/<session_id>/face", methods=["POST"])
@login_required
def select_face(session_id):
    sess = _require_session(session_id)
    data = request.get_json(force=True, silent=True) or {}
    try:
        face_index = int(data["face_index"])
    except (KeyError, TypeError, ValueError):
        return _err(ValueError("face_index manquant/invalide"))

    try:
        info = mw.find_flat_region(sess.mesh(), sess.face_adjacency(), face_index)
    except mw.MeshError as exc:
        return _err(exc)

    result = info.to_json()
    result["face_index"] = face_index
    result["suggested_width_mm"] = round(min(info.width, info.height) * 0.7, 1)
    return jsonify(result)


# --- preview (fast, boolean-free) ----------------------------------------------
@app.route("/api/session/<session_id>/preview", methods=["POST"])
@login_required
def preview(session_id):
    sess = _require_session(session_id)
    if not sess.logo_path.exists():
        return _err(ValueError("aucun logo importé pour cette session"))
    data = request.get_json(force=True, silent=True) or {}
    try:
        face_index = int(data["face_index"])
        params = _placement_params(data)
    except (KeyError, TypeError, ValueError) as exc:
        return _err(ValueError(f"paramètres invalides ({exc})"))

    try:
        info = mw.find_flat_region(sess.mesh(), sess.face_adjacency(), face_index)
        mesh = mw.preview_logo(sess.active_logo_polygons(), info, params)
    except mw.MeshError as exc:
        return _err(exc)
    return _mesh_to_glb_response(mesh)


# --- export ----------------------------------------------------------------
@app.route("/api/session/<session_id>/export", methods=["POST"])
@login_required
def export(session_id):
    sess = _require_session(session_id)
    if not sess.logo_path.exists():
        return _err(ValueError("aucun logo importé pour cette session"))
    data = request.get_json(force=True, silent=True) or {}
    try:
        face_index = int(data["face_index"])
        params = _placement_params(data)
        mode = data.get("mode", "emboss")
        depth_mm = max(0.1, float(data.get("depth_mm", 1.5)))
        sink_mm = max(0.0, float(data.get("sink_mm", 0.3)))
        fill_extra_mm = max(0.0, float(data.get("fill_extra_mm", 0.0)))
    except (KeyError, TypeError, ValueError) as exc:
        return _err(ValueError(f"paramètres invalides ({exc})"))
    if mode not in ("emboss", "deboss"):
        return _err(ValueError("mode invalide (emboss|deboss)"))

    try:
        info = mw.find_flat_region(sess.mesh(), sess.face_adjacency(), face_index)
        polygons = sess.active_logo_polygons()
        if mode == "emboss":
            logo = mw.emboss(polygons, info, params, depth_mm=depth_mm, sink_mm=sink_mm)
            named = {"base": sess.mesh(), "logo": logo}
        else:
            pocketed, fill = mw.deboss(sess.mesh(), polygons, info, params,
                                        depth_mm=depth_mm, fill_extra_mm=fill_extra_mm)
            named = {"base": pocketed, "logo_fill": fill}
        data_3mf = mw.export_3mf(named)
    except mw.MeshError as exc:
        return _err(exc)

    return send_file(io.BytesIO(data_3mf), mimetype="model/3mf",
                      as_attachment=True, download_name="autologo.3mf")


# --- admin: assembly upload + zone builder --------------------------------------
@app.route("/api/admin/upload/assembly", methods=["POST"])
@login_required
def admin_upload_assembly():
    f = request.files.get("file")
    if not f or not f.filename:
        return _err(ValueError("aucun fichier reçu"))
    ext = "." + f.filename.rsplit(".", 1)[-1].lower() if "." in f.filename else ""
    if ext not in config.MODEL_EXTS:
        return _err(ValueError(f"format non supporté ({ext or '?'}) — "
                                f"attendu: {', '.join(sorted(config.MODEL_EXTS))}"))

    sess = store.create()
    sess.is_assembly = True
    sess.model_ext = ext
    f.save(str(sess.model_path))

    try:
        mesh = sess.mesh()
        sess.glb_path.write_bytes(mw.to_glb(mesh))
    except mw.MeshError as exc:
        return _err(exc)

    bounds = mesh.bounds
    return jsonify({
        "session_id": sess.id,
        "glb_url": url_for("session_glb", session_id=sess.id),
        "bounds": {"min": bounds[0].tolist(), "max": bounds[1].tolist()},
        "scale_mm": round(float(mesh.scale), 2),
        "parts": [{"name": p["name"], "face_count": p["face_count"]} for p in sess.parts],
    })


@app.route("/api/admin/session/<session_id>/face", methods=["POST"])
@login_required
def admin_select_face(session_id):
    sess = _require_session(session_id)
    if not sess.is_assembly:
        return _err(ValueError("session invalide (pas un assemblage)"))
    data = request.get_json(force=True, silent=True) or {}
    try:
        face_index = int(data["face_index"])
    except (KeyError, TypeError, ValueError):
        return _err(ValueError("face_index manquant/invalide"))

    try:
        info = mw.find_flat_region(sess.mesh(), sess.face_adjacency(), face_index)
        part = mw.part_for_face(sess.parts, face_index)
    except mw.MeshError as exc:
        return _err(exc)

    result = info.to_json()
    result["face_index"] = face_index
    result["part_name"] = part["name"]
    return jsonify(result)


@app.route("/api/admin/products", methods=["POST"])
@login_required
def admin_create_product():
    data = request.get_json(force=True, silent=True) or {}
    sess = _require_session(data.get("session_id", ""))
    name = (data.get("name") or "").strip() or "Produit sans nom"
    export_mode = data.get("export_mode", "assembly")
    if export_mode not in ("assembly", "part"):
        return _err(ValueError("export_mode invalide (assembly|part)"))
    zones_in = data.get("zones") or []
    if not zones_in:
        return _err(ValueError("ajoutez au moins une zone avant de publier"))

    product_id = uuid.uuid4().hex[:10]
    pdir = config.PRODUCTS_DIR / product_id
    pdir.mkdir(parents=True, exist_ok=True)
    shutil.copy(str(sess.model_path), str(pdir / f"model{sess.model_ext}"))
    if sess.glb_path.exists():
        shutil.copy(str(sess.glb_path), str(pdir / "assembly.glb"))
    bounds = sess.mesh().bounds
    bounds_json = json.dumps({"min": bounds[0].tolist(), "max": bounds[1].tolist()})
    colors_json = json.dumps({k: list(v) for k, v in sess.part_colors.items()})

    try:
        db.create_product(product_id, name, sess.model_ext, export_mode, bounds_json, colors_json)
        for i, z in enumerate(zones_in):
            face = z.get("face") or {}
            for key in ("origin", "normal", "u", "v", "width", "height"):
                if key not in face:
                    raise ValueError(f"zone {i + 1}: information de face incomplète")
            mode = z.get("mode", "emboss")
            if mode not in ("emboss", "deboss"):
                raise ValueError(f"zone {i + 1}: mode invalide")
            db.add_zone(
                product_id=product_id,
                part_name=str(z.get("part_name", "")),
                label=str(z.get("label") or f"Zone {i + 1}"),
                face_json=json.dumps(face),
                mode=mode,
                depth_mm=max(0.1, float(z.get("depth_mm", 1.5))),
                sink_mm=max(0.0, float(z.get("sink_mm", 0.3))),
                fill_extra_mm=max(0.0, float(z.get("fill_extra_mm", 0.0))),
                sort_order=i,
            )
    except (ValueError, TypeError) as exc:
        db.delete_product(product_id)
        shutil.rmtree(pdir, ignore_errors=True)
        return _err(exc)

    return jsonify({
        "product_id": product_id,
        "customer_url": url_for("customer_order", product_id=product_id, _external=True),
    })


# --- customer: order workflow ----------------------------------------------------
def _zone_public(z) -> dict:
    """Everything the customer's browser needs: the zone's placement (mm
    dimensions + full face geometry, so drag-to-position can do the same
    plane-intersection math the single-tool page does) — never `mode`,
    `depth_mm`, `sink_mm` or `fill_extra_mm`, which stay vendor-locked."""
    face = json.loads(z["face_json"])
    return {
        "id": z["id"], "label": z["label"],
        "width": face["width"], "height": face["height"],
        "origin": face["origin"], "normal": face["normal"],
        "u": face["u"], "v": face["v"],
        "suggested_width_mm": round(min(face["width"], face["height"]) * 0.7, 1),
    }


@app.route("/api/product/<product_id>")
def api_product(product_id):
    product = db.get_product(product_id)
    if product is None:
        abort(404, "produit introuvable")
    zones = db.list_zones(product_id)
    return jsonify({
        "name": product["name"],
        "glb_url": url_for("product_glb", product_id=product_id),
        "bounds": json.loads(product["bounds_json"]),
        "zones": [_zone_public(z) for z in zones],
    })


@app.route("/product/<product_id>/assembly.glb")
def product_glb(product_id):
    path = config.PRODUCTS_DIR / product_id / "assembly.glb"
    if not path.exists():
        abort(404)
    return send_file(str(path), mimetype="model/gltf-binary", max_age=3600)


def _require_order_session(order_session_id: str):
    sess = orders.get(order_session_id)
    if sess is None:
        abort(404, "session de commande introuvable ou expirée")
    return sess


def _require_zone(sess, zone_id: int):
    zone_row = db.get_zone(zone_id)
    if zone_row is None or zone_row["product_id"] != sess.product_id:
        abort(404, "zone introuvable pour ce produit")
    return zone_row


@app.route("/api/order/<product_id>/start", methods=["POST"])
def order_start(product_id):
    product = db.get_product(product_id)
    if product is None:
        return _err(ValueError("produit introuvable"), 404)
    sess = orders.start(product_id)
    return jsonify({"order_session_id": sess.id})


@app.route("/api/order/session/<order_session_id>/zone/<int:zone_id>/logo", methods=["POST"])
def order_upload_logo(order_session_id, zone_id):
    sess = _require_order_session(order_session_id)
    _require_zone(sess, zone_id)
    f = request.files.get("file")
    if not f or not f.filename:
        return _err(ValueError("aucun fichier reçu"))
    if not f.filename.lower().endswith(".svg"):
        return _err(ValueError("le logo doit être un fichier .svg"))

    work = sess.zone(zone_id)
    f.save(str(work.logo_path))
    work.invalidate_logo()
    try:
        polygons = work.logo_polygons()
    except mw.MeshError as exc:
        work.logo_path.unlink(missing_ok=True)
        return _err(exc)

    minx, miny, maxx, maxy = mw.logo_bounds(polygons)
    return jsonify({
        "ok": True,
        "logo_bounds": {"width": round(float(maxx - minx), 2),
                         "height": round(float(maxy - miny), 2)},
        "shapes": mw.shapes_payload(polygons),
    })


@app.route("/api/order/session/<order_session_id>/zone/<int:zone_id>/edit", methods=["POST"])
def order_edit_logo(order_session_id, zone_id):
    sess = _require_order_session(order_session_id)
    _require_zone(sess, zone_id)
    work = sess.zone(zone_id)
    if not work.has_logo():
        return _err(ValueError("aucun logo importé pour cette zone"))
    data = request.get_json(force=True, silent=True) or {}
    try:
        excluded = {int(i) for i in data.get("excluded", [])}
    except (TypeError, ValueError):
        return _err(ValueError("liste d'exclusion invalide"))
    n = len(work.logo_polygons())
    work.excluded_shapes = {i for i in excluded if 0 <= i < n}
    work.flip_h = bool(data.get("flip_h", False))
    work.flip_v = bool(data.get("flip_v", False))
    try:
        minx, miny, maxx, maxy = mw.logo_bounds(work.active_logo_polygons())
    except mw.MeshError as exc:
        return _err(exc)
    return jsonify({
        "ok": True,
        "logo_bounds": {"width": round(float(maxx - minx), 2),
                         "height": round(float(maxy - miny), 2)},
    })


@app.route("/api/order/session/<order_session_id>/zone/<int:zone_id>/preview", methods=["POST"])
def order_preview(order_session_id, zone_id):
    sess = _require_order_session(order_session_id)
    zone_row = _require_zone(sess, zone_id)
    work = sess.zone(zone_id)
    if not work.has_logo():
        return _err(ValueError("aucun logo importé pour cette zone"))
    data = request.get_json(force=True, silent=True) or {}
    try:
        work.width_mm = max(1.0, float(data.get("width_mm", 20.0)))
        work.rotation_deg = float(data.get("rotation_deg", 0.0)) % 360.0
        work.offset_x_mm = float(data.get("offset_x_mm", 0.0))
        work.offset_y_mm = float(data.get("offset_y_mm", 0.0))
    except (TypeError, ValueError) as exc:
        return _err(ValueError(f"paramètres invalides ({exc})"))

    try:
        face = mw.FaceInfo.from_json(json.loads(zone_row["face_json"]))
        mesh = mw.preview_logo(work.active_logo_polygons(), face, work.placement_params())
    except mw.MeshError as exc:
        return _err(exc)
    return _mesh_to_glb_response(mesh)


@app.route("/api/order/session/<order_session_id>/zone/<int:zone_id>/fit", methods=["POST"])
def order_fit(order_session_id, zone_id):
    sess = _require_order_session(order_session_id)
    zone_row = _require_zone(sess, zone_id)
    work = sess.zone(zone_id)
    if not work.has_logo():
        return _err(ValueError("aucun logo importé pour cette zone"))
    try:
        face = mw.FaceInfo.from_json(json.loads(zone_row["face_json"]))
        width_mm, rotation_deg = mw.fit_to_face(work.active_logo_polygons(), face)
    except mw.MeshError as exc:
        return _err(exc)
    return jsonify({"width_mm": width_mm, "rotation_deg": rotation_deg})


@app.route("/api/order/session/<order_session_id>/submit", methods=["POST"])
def order_submit(order_session_id):
    sess = _require_order_session(order_session_id)
    try:
        code = orders.submit(sess)
    except mw.MeshError as exc:
        return _err(exc)
    return jsonify({"order_code": code})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000, debug=True)
