"""Flask app: password login + upload/place/export workflow for AutoLogo."""
from __future__ import annotations

import functools
import hmac
import io
import logging
import os
from datetime import timedelta

from flask import (Flask, abort, flash, jsonify, redirect, render_template,
                    request, send_file, session, url_for)
from werkzeug.exceptions import HTTPException
from werkzeug.middleware.proxy_fix import ProxyFix

from . import config, meshwork as mw, store

_HTML_ROUTES = {"/", "/login", "/logout"}

logging.basicConfig(level=logging.INFO,
                     format="%(asctime)s %(levelname)s %(name)s | %(message)s")
log = logging.getLogger("autologo")

app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)
app.secret_key = config.SECRET_KEY or os.urandom(32)
app.permanent_session_lifetime = timedelta(days=7)
app.config["MAX_CONTENT_LENGTH"] = config.MAX_UPLOAD_MB * 1024 * 1024

config.SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
store.start_cleanup_thread()
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
    the real error."""
    if request.path in _HTML_ROUTES:
        raise exc
    code = exc.code if isinstance(exc, HTTPException) else 500
    message = exc.description if isinstance(exc, HTTPException) else str(exc)
    if code >= 500:
        log.exception("Unhandled error on %s", request.path)
    return jsonify({"error": message}), code


@app.route("/login", methods=["GET", "POST"])
def login():
    if session.get("authed"):
        return redirect(url_for("index"))
    if request.method == "POST":
        supplied = request.form.get("password", "")
        if config.DASHBOARD_PASSWORD and hmac.compare_digest(supplied, config.DASHBOARD_PASSWORD):
            session.clear()
            session["authed"] = True
            session.permanent = True
            nxt = request.args.get("next")
            if not nxt or not nxt.startswith("/"):
                nxt = url_for("index")
            return redirect(nxt)
        flash("Mot de passe incorrect.")
    return render_template("login.html")


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.route("/")
@login_required
def index():
    return render_template("index.html")


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
        info = mw.find_flat_region(sess.mesh(), sess.welded(), face_index)
        width_mm, rotation_deg = mw.fit_to_face(sess.active_logo_polygons(), info.width, info.height)
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
        info = mw.find_flat_region(sess.mesh(), sess.welded(), face_index)
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
        info = mw.find_flat_region(sess.mesh(), sess.welded(), face_index)
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
        info = mw.find_flat_region(sess.mesh(), sess.welded(), face_index)
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


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8000, debug=True)
