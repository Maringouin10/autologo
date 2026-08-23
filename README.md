# 🏷️ AutoLogo

Self-hosted web app to stamp a logo onto a 3D-printable model and export a
**multi-object 3MF** — the base and the logo are kept as **separate objects**
so a slicer (PrusaSlicer, Bambu Studio, OrcaSlicer…) can assign each its own
filament/color for multi-material printing.

Runs entirely in one Docker container; nothing is uploaded anywhere else. It
does two things:

- **The plain tool** (`/`, password-protected): upload any single-part 3D
  model + an SVG logo, position it, export. Good for one-off jobs.
- **The vendor platform** (`/admin` → `/o/<product>`): you (the vendor) upload
  a multi-part assembly once, mark exactly which piece(s)/face(s) a customer
  is allowed to put a logo on and with what print settings, and publish it.
  Customers open the public link — no account, no password — place their
  logo on the spot(s) you approved, and submit; you get back a 3MF (the
  customized piece, or the whole assembly) plus a unique order code to match
  against wherever you actually take the order/payment.

## Quick start

```bash
git clone https://github.com/Maringouin10/autologo && cd autologo
cp .env.example .env   # set DASHBOARD_PASSWORD / SECRET_KEY (or leave blank for no login)
docker compose up -d --build
```

Open **http://localhost:8010** for the plain tool, or **/admin** for the
vendor platform.

## The vendor platform

1. **`/admin` → + Nouveau produit.** Upload a multi-part **3MF** assembly
   (STL/OBJ work too but won't have separate parts). The whole assembly loads
   in one viewer — the part under your click is resolved automatically, so
   clicking behaves exactly like the plain tool even though it's several
   parts glued together.
2. **Click a flat face** on the piece you want customizable, name the zone,
   set **mode** (relief/gravé) and **depth/anchor** — these are locked for
   customers, exactly so you keep control of print cost/waste (a purge tower
   for multi-material is not free). Repeat for more zones/pieces if you want
   more than one customizable spot; most products just need one.
3. **Publish**, choosing whether customers' downloads (and yours) contain
   the **whole assembly** or **just the customized piece(s)**. You get a
   public link (`/o/<product_id>`) to send customers, and a product page
   listing every order received with a 3MF download for each.
4. **Customer side** (`/o/<product_id>`, no login): upload an SVG, exclude
   shapes/mirror it if needed, drag/resize/fit it into the approved zone(s),
   hit **Envoyer ma commande** — they get a short order code back. Nothing
   else happens automatically yet (no payment, no email) — wire that code
   into whatever order form/checkout you already use.

## How the plain tool works

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

- Sessions (uploaded files + cache, for the plain tool **and** for a
  customer mid-order) live under the `./data` volume, one directory per
  session, cleaned up automatically after `SESSION_TTL_HOURS`. **Products
  and submitted orders are not sessions** — they're kept indefinitely
  (`./data/autologo.db`, `./data/products/`, `./data/orders/`) until you
  delete a product from its admin page.
- The live preview never runs a boolean operation (it just shows where the
  logo will sit) — only **Export** in *gravé* mode runs the actual cut, so
  slider dragging stays fast even on a large model.
- If a *gravé* export fails with a "not watertight" error, the source model
  has gaps/non-manifold geometry that the boolean engine can't cut through
  cleanly — repair it first (e.g. in Blender / PrusaSlicer's fix tool), or
  use *relief* mode instead, which has no such requirement.
