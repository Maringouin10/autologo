# 🏷️ AutoLogo

Self-hosted web app to stamp a logo onto a 3D-printable model and export a
**multi-object 3MF** — the base and the logo are kept as **separate objects**
so a slicer (PrusaSlicer, Bambu Studio, OrcaSlicer…) can assign each its own
filament/color for multi-material printing.

Runs entirely in one Docker container; nothing is uploaded anywhere else. It
does three things:

- **The public gallery** (`/`, no login): every published product, as a
  clickable grid — the storefront customers land on.
- **The vendor platform** (`/admin` → `/o/<product>`): you (the vendor) upload
  a multi-part assembly once, mark exactly which piece(s)/face(s) a customer
  is allowed to put a logo on and with what print settings, and publish it.
  Customers open the product from the gallery (or its direct link) — no
  account, no password — place their logo on the spot(s) you approved, and
  submit; you get back a 3MF (the customized piece, or the whole assembly)
  plus a unique order code to match against wherever you actually take the
  order/payment.
- **The plain tool** (`/tool`, password-protected): upload any single-part
  3D model + an SVG logo, position it, export. Good for one-off jobs that
  don't need a product page at all.

## Quick start

```bash
git clone https://github.com/Maringouin10/autologo && cd autologo
cp .env.example .env   # set DASHBOARD_PASSWORD / SECRET_KEY (or leave blank for no login)
docker compose up -d --build
```

Open **http://localhost:8010** for the public gallery, **/admin** to manage
products, or **/tool** for the plain single-model tool.

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
   **✎ Modifier ce produit** reopens the same screen on a published
   product: rename it, switch its export mode, rename/retune/remove its
   zones, or click new faces to add more. Zones you keep are left exactly
   where they are (their stored face is reused untouched), the link and
   past orders are unaffected, and you can't save a product with no zones
   left. The 3D model itself is fixed once published — the zones are
   pinned to that mesh's faces — so changing model means a new product.
4. **Identical faces.** A cube's four sides, a keychain's two faces… mark
   them as one **groupe de faces identiques** in the zone form (the
   *Faces identiques* picker: pick a face, choose the group, add it, then
   click the next face — the picker stays on the same group). The customer
   then gets a single control for the whole group with two buttons:
   **Le même partout** (one logo, placed once, applied to every face of the
   group) or **Un par face** (one dropzone and one placement per face).
   Ungrouped zones behave exactly as before.
5. **Customer side** (`/o/<product_id>`, no login): upload an SVG, exclude
   shapes/mirror it if needed, drag/resize/fit it into the approved zone(s),
   pick the filament colors, hit **Envoyer ma commande** — they get a short
   order code back. Nothing else happens automatically yet (no payment, no
   email) — wire that code into whatever order form/checkout you already use.

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

## Automatic mesh repair (gravé)

A boolean cut needs both operands to be *volumes* — watertight, consistently
wound, positive volume — and most real models aren't. That used to end the
job with **"Not all meshes are volumes!"** and a suggestion to go repair the
file yourself. Now `meshwork.repair_for_boolean()` fixes what is fixable,
automatically, before the cut:

| what it does | what it fixes |
|---|---|
| weld vertices, drop duplicate / zero-area / NaN faces | STL triangles exported unwelded (the most common case by far), duplicated faces, slivers |
| `fix_winding` + `fix_inversion` | a face or two exported inside-out |
| drop disconnected scraps (keeping anything with a real share of the surface) | a stray triangle or leftover sketch line floating next to the part |
| `fill_holes` | a missing face, an open corner |
| weld again at a tolerance scaled to the model (0.001% → 0.05% of its size) | the hairline cracks CAD exports leave behind |
| `fix_normals` | anything left |

Each step runs on a copy, is kept only if it helps, and the chain stops as
soon as the mesh qualifies — a healthy model pays for one `is_volume` check
and nothing else. **The cutting tool (the extruded logo) is repaired the
same way**: an SVG with overlapping or self-touching outlines produced the
identical error, from the other operand.

### The logo is the other half of it

The same error came just as often from the *cutting tool* — the extruded
logo — and blaming the model sent people off repairing a perfectly good
STL. Two construction bugs made ordinary artwork unusable:

- **Walls are now built from the cap triangulation's own boundary**, not
  from the input rings. The two disagree as soon as a hole touches the
  outline — a letter counter kissing the edge, say: the triangulation
  splits the outer edge at the contact point while a ring-based wall spans
  it in one piece. Every such T-junction left a pair of open edges, the
  solid was never watertight, and no repair pass could close it.
- **A shape that pinches to zero width is nudged apart** (`_unpinch`): a
  hole meeting the outline at a single point leaves the material
  infinitely thin there, four faces share one edge, and that is not a
  volume by definition — nor printable. Holes are shrunk by ~0.01% of the
  shape, below any nozzle, which both fixes the geometry and matches what
  the printer could do.
- A **self-crossing outline** (a stroke converted to a path, an "optimized"
  export) used to be dropped silently, so the piece just went missing.
  `buffer(0)` rebuilds it into valid pieces instead.

It is not silent: the export sends back an `X-Autologo-Repairs` header and
the tool page raises a toast naming the repairs, the server logs them, and
picking *gravé* on a model that isn't watertight shows a notice saying it
will be repaired at export. If a mesh genuinely cannot be closed (an open
surface with no inside), the error now says what was already attempted and
points at relief mode.

`tests/test_mesh_repair.py` builds seven broken meshes, checks each one is
repaired *and* that the repair preserves the shape (volume within 2%), then
runs a real cut on every one of them. It also covers the logo side: holes
touching the outline (at a point and along an edge), holes touching each
other, self-crossing outlines, overlapping shapes, and that an extrusion's
volume still matches its outline's area exactly.

When a cut genuinely can't happen, the error now names **which** side is at
fault — the model or the logo — and what was already tried on it.

## Reading the SVG

A logo is read shape by shape (that is what makes the shape picker and the
per-color export possible), which means the reader has to reproduce what a
browser would draw — and that is where misplaced pieces came from:

- **Transforms are composed from the SVG root down.** Every real export
  (Illustrator artboards, Inkscape layers, Figma frames) nests shapes in
  transformed groups; a shape lifted out of its ancestors landed at the
  untransformed position. The matrices are also computed here rather than
  by trimesh, whose SVG reader mis-reads `rotate(a)` (it treats the angle
  as radians) and `translate(tx)` (it reuses tx for ty) — both of which
  silently move a piece somewhere else. `matrix`, `translate`, `scale`,
  `rotate` (with or without a centre), `skewX`/`skewY` and multi-function
  transform lists are supported.
- **Only what the file actually draws is imported.** `<defs>`, `<clipPath>`,
  `<mask>`, `<symbol>`, `<pattern>` and friends define content that is not
  rendered on its own — walking into them used to add phantom pieces, most
  visibly a `<defs>` background rect covering the whole canvas. Elements
  hidden with `display:none` / `visibility:hidden` are skipped too.
- **`<use>` is expanded**, with its own `x`/`y`/`transform` applied, so a
  logo built out of repeated symbols keeps all of its pieces (they used to
  vanish, or show up once at the original's position).
- **Overlaps are flattened the way a browser paints them.** SVG draws in
  document order, so a shape hides whatever sits under it — but each shape
  was extruded into its own solid, which left two solids in the same place:
  the 3D view showed both colors fighting over the same spot, and a slicer
  would have been handed two filaments for one volume. Each shape now keeps
  only the part no later shape covers. A background plate comes back punched
  with holes, a shape hidden completely disappears (it was invisible in the
  SVG too), and one cut in two becomes two pieces — which is what it is once
  printed. On a two-circles-on-a-plate logo this removed 3 923 mm² of
  doubly-painted material.
- `fill="none"` shapes (stroke-only guides) are still ignored, and colors
  still come from `fill` attributes, inline styles and `<style>` blocks.

`tests/test_svg_parsing.py` pins all of the above:

```bash
python -m unittest discover -s tests
```

## The logo edit step

- **Each thumbnail is drawn in the whole logo's frame**, with the rest of
  the logo ghosted behind it — so a card shows *where* its piece sits
  instead of a context-free silhouette scaled to its own bounding box.
- **The big preview is the editing surface**: click a piece to exclude it,
  click it again (it stays visible, ghosted) to put it back. Hovering a
  card outlines the matching piece, and vice versa.
- A piece that covers nearly the whole logo and is solid gets a **`fond ?`**
  badge — that is almost always a background plate to remove.
- **One-click cleanups**, shown only when they apply: *Retirer le fond*
  (the bottom-most shape spanning the whole artwork) and *Retirer N miettes*
  (specks under 0.4% of the largest piece — stray anchor points, scan dust).
  A typical messy logo is cleaned in two clicks instead of hunting through
  thumbnails.
- **Annuler** undoes the last change (30 steps of history), so cleaning can
  be trial and error.
- **Tout inclure / Tout exclure** plus a `n/m formes incluses` counter.
- Excluding every piece no longer fires a request the server can only
  refuse: the step says what is wrong and holds the export/order button.
- Both the vendor tool and the customer page share one implementation
  (`app/static/js/logo-editor.js`); on the customer page the thumbnails are
  drawn in the **chosen filament colors**, not the artwork's own.

## Couleurs d'impression

The customer picks a filament for **the object itself** and one for **each
color their logo uses**, from a palette of what you stock — a color counter
keeps the whole order within `MAX_PRINT_COLORS` (4 by default: one AMS/MMU's
worth), and an order that exceeds it can't be submitted.

- The palette lives in `app/config.py` (`DEFAULT_PALETTE`) and can be replaced
  per-deployment with the **`FILAMENT_COLORS`** env var — JSON, e.g.
  `[{"name":"Noir","hex":"#1c1c1e"},{"name":"PETG rouge","hex":"#d92b2b"}]`.
  An unparseable value falls back to the built-in list rather than leaving a
  customer with no colors to pick.
- Picks are applied everywhere at once: the 3D view repaints the object and
  the logo, the shape thumbnails show the chosen filaments, and the exported
  3MF carries them as real per-object display colors — trimesh's own 3MF
  writer drops color entirely, so the app injects the `<basematerials>`
  resource itself (`meshwork._inject_3mf_colors`). How far a given slicer
  honors that varies, so **the admin also lists each order's colors** as
  swatches (hover for the filament name) next to its download button.
- Two source colors mapped to the same filament merge into one object in the
  export — one filament, one object.
- The colors are chosen per order, not per product: `/tool` (the plain
  single-model tool) still exports in the model's own colors.

## L'interface

Toutes les pages partagent un même thème (`app/static/css/style.css` — tous
les tokens de couleur/rayon/ombre sont dans son bloc `:root`) et un gabarit
Jinja commun (`app/templates/base.html`).

- **Utilisable au téléphone** : sous 860 px, l'écran de placement s'empile —
  l'objet 3D en haut, les réglages dans une feuille défilante en dessous —
  au lieu d'une barre latérale fixe de 320 px illisible sur mobile. La
  galerie et l'admin passent en colonne unique.
- **Parcours guidé** : chaque étape porte un numéro qui passe au vert une
  fois franchie, et les étapes suivantes restent grisées tant qu'elles ne
  sont pas accessibles.
- **Les erreurs ne passent plus inaperçues** : elles s'affichent en toast
  (coin de l'écran) au lieu d'une ligne rouge en bas d'un panneau défilant,
  et les opérations longues (import, découpe booléenne, envoi de commande)
  couvrent la vue 3D d'un voile avec un libellé disant ce qui se passe.
- **Vue 3D** : fond dégradé, bouton *recentrer* (⟳) pour retrouver un modèle
  qu'on a perdu en orbitant, et bouton plein écran (⛶).
- **Admin** : les produits sont des cartes (couleur du modèle, nombre de
  zones, pastille « à traiter » s'il y a des commandes en attente) et les
  dates sont relatives (« il y a 2 h »), l'horodatage exact restant en
  infobulle. Chaque commande affiche les filaments choisis en pastilles.

## Orders, admin side

- **Every order has its own page** (`/admin/orders/<code>`, reached from the
  order code or the 👁 button): the finished 3MF **in a 3D viewer**, with
  each object shown in the filament the customer picked, next to the
  filament list, the order's state and the download/done buttons. The
  preview is the exported file itself, rebuilt server-side as a GLB
  (`meshwork.scene_to_glb`) and cached beside it — what you see is what
  prints, not a re-render of the configuration.
- **Downloads are named after the object**: `mug-personnalise_AB12CD.3mf`
  instead of `commande_AB12CD.3mf`, and the plain tool names its export
  after the model you uploaded (`porte-cle-ete-2026_logo.3mf`). Ten of them
  in a downloads folder stay tellable apart.

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
- A **3MF** with real per-part color (`<basematerials>`/`<m:colorgroup>`
  display colors — set in your slicer/CAD tool) shows that color in every
  viewer and as the gallery card's swatch, instead of the flat default gray.
  Plain STL/OBJ imports, or a 3MF with no color info, keep the default.
- **Fitting to the plate** comes in two flavours, side by side:
  *Agrandir au max* scans rotations for the biggest the logo can possibly
  be, and *Max sans tourner* gives the biggest it can be **at the angle it
  is already placed at** — a few degrees of tilt buys a little size and
  reads as a mistake on anything with a horizon (text, a badge). Both fit
  against the flat region's *actual outline*, not its bounding box — a round
  or L-shaped spot is smaller than the rectangle around it — with a
  1&nbsp;mm clearance on every side. On a 30×80 plate with a wide logo:
  78 mm turned, 28 mm kept flat.
- **Quarter-turn buttons** (0° / 90° / 180° / 270°) sit above the rotation
  slider: landing a 0-360 slider exactly on 90 is fiddly, and quarter turns
  are what people reach for. The active one lights up, and moving the
  slider by hand clears it.
- **A logo SVG may use up to 3 colors.** Fills are read from `fill`
  attributes, inline `style="fill:…"`, **and `<style>` blocks with class /
  id / element selectors** (how Illustrator, Figma and most "optimized"
  SVG exports actually store color), following normal CSS precedence and
  group inheritance. Each element's resolved fill is read and
  every distinct color becomes its own object in the exported 3MF
  (`logo_1_ff0000`, `logo_2_0000ff`, …) so you can assign one filament per
  color in the slicer; all groups share one placement, so they stay in
  register. The shape picker and the 3D preview show the real colors. A
  4th+ color is merged into the nearest kept one rather than dropped, and
  `fill="none"` shapes (stroke-only guides) are ignored. An SVG with no
  fill info prints as a single default color, exactly as before.
- A *gravé* export no longer fails on a model that isn't watertight: the
  mesh is repaired automatically first (see **Automatic mesh repair**). Only
  a model with no inside at all — an open surface — still can't be cut, and
  relief mode remains the way out.
