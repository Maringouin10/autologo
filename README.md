# 🏷️ AutoLogo

Self-hosted, password-protected web app to stamp a logo onto a 3D-printable
model: upload a **3D model** (STL/OBJ/PLY/3MF) and an **SVG logo**, click a
**flat face** in the 3D viewer, position the logo on it, and export a
**multi-object 3MF** — the base and the logo are kept as **separate objects**
so a slicer (PrusaSlicer, Bambu Studio, OrcaSlicer…) can assign each its own
filament/color for multi-material printing.

Runs entirely in one Docker container; nothing is uploaded anywhere else.

## Quick start

```bash
git clone https://github.com/Maringouin10/autologo && cd autologo
cp .env.example .env   # set DASHBOARD_PASSWORD / SECRET_KEY (or leave blank for no login)
docker compose up -d --build
```

Open **http://localhost:8010**.

## How it works

1. **Upload the 3D model.** It's parsed with `trimesh` and converted to glTF
   for the in-browser viewer (Three.js), face-for-face identical to the
   server-side mesh — the triangle index the browser reports on a click is
   the exact triangle index the backend uses.
2. **Upload the SVG logo.**
3. **Click a flat face.** The backend flood-fills outward from the clicked
   triangle, gathering every triangle that shares (within tolerance) its
   normal and its plane — i.e. the whole flat patch, not just one triangle —
   and reports its size so the logo can be auto-sized to fit.
4. **Adjust size / rotation / offset** with the sliders; a live (boolean-free)
   preview updates in the 3D view.
5. **Pick a mode and export:**
   - **Relief (emboss)** — the logo is extruded and placed as its own
     protruding object, sunk slightly into the model's surface so the two
     parts bond instead of merely touching. Works on any model.
   - **Gravé (deboss)** — the logo's footprint is *subtracted* from the
     model (a boolean cut via `manifold3d`) and a matching **fill piece** is
     produced to sit exactly in the resulting pocket — the classic two-color
     engraved-logo workflow. Requires the input model to be watertight.

Either way the export is a single `.3mf` containing two objects at their
final absolute positions — open it in your slicer and assign a different
filament/color to each.

## Configuration (`.env`)

| variable | default | description |
|---|---|---|
| `DASHBOARD_PASSWORD` | — | login password; leave empty to disable login |
| `SECRET_KEY` | — | session cookie signing key |
| `SESSION_TTL_HOURS` | `6` | how long an upload session (and its files) is kept |
| `MAX_UPLOAD_MB` | `200` | upload size cap |

## Notes

- Sessions (uploaded files + cache) live under the `./data` volume, one
  directory per session, cleaned up automatically after `SESSION_TTL_HOURS`.
- The live preview never runs a boolean operation (it just shows where the
  logo will sit) — only **Export** in *gravé* mode runs the actual cut, so
  slider dragging stays fast even on a large model.
- If a *gravé* export fails with a "not watertight" error, the source model
  has gaps/non-manifold geometry that the boolean engine can't cut through
  cleanly — repair it first (e.g. in Blender / PrusaSlicer's fix tool), or
  use *relief* mode instead, which has no such requirement.
