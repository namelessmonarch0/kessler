# Object sprites: pixel-icon objects on the GPU

Date: 2026-09-24. Status: approved by the owner (all sections; "I approve all so start building").

## Why

The globe draws ~28.6k objects (LEO) as tiny 3D meshes: satellites are boxes plus panels that smear into white
streaks, objects grow on screen as you zoom in, and every frame the CPU interpolates, orients (`lookAt`) and
writes a matrix for every object in JavaScript. Goal: better-looking objects, never oversized, and far cheaper
to draw.

## Decisions (owner)

- Look: rich shaded pixel icons (mockup option B): three tones (light, base, dark) of each type's globe colour,
  several variants per type (4 payload, 2 rocket body, 6 debris).
- Icons point along their direction of travel, snapped to 8 screen angles so pixels stay crisp.
- Selected object: its icon enlarged (at least 4.5 CSS px per sprite pixel and 1.5× its neighbours) inside corner
  brackets drawn at a fixed 2 CSS px thickness, plus its orbit path.
- Approach: GPU point sprites (one point per object, one draw call per orbit group).

## Behaviour

- Size grows smoothly with zoom (revised 2026-09-25 after owner feedback that fixed 1 px sprites were too small
  and didn't grow): CSS px per sprite pixel = clamp(1.5·√(Earth radius px / 330), 1.5, 6); dots scale by
  clamp(√(Earth radius px / 265), 1, 2). Fractional scales use sharp-bilinear sampling (solid sprite pixels,
  one-device-pixel blends at their seams), so growth is continuous without blur or uneven pixel columns. Point
  centres snap to the device-pixel grid.
- Level of detail by the Earth's on-screen radius: plain dots when zoomed out (2 px payload and rocket body,
  1–2 px debris, base colour), crossfading into icons through an ordered-dither band as you zoom in. Thresholds
  tuned from screenshots.
- Orientation: the shader projects the object's velocity (next − previous frame) to screen space and picks one
  of 8 sectors (0 = right, counter-clockwise in 45° steps). Each sprite has a straight (pointing right) and an
  optional diagonal (pointing up-right) drawing; 90° rotations of those give all 8, losslessly. Debris has no
  diagonal drawing (tumbling fragments; odd sectors reuse the straight drawing).
- Variant per object is fixed by NORAD ID, so shapes never swap between frames.
- Depth: points depth-test against the Earth; transparent texels are discarded (no blending, no sorting).
- Objects keep full brightness over the night side (as today).
- Same renderer for the LEO and HIGH groups.

## Components (web/src/components/globe/)

- `objectSprites.ts`: sprite pixel data as strings, `rotateCCW`, `spriteGrid(sprite, sector)`.
- `spriteAtlas.ts`: RGBA atlas (8 sector columns × 12 sprite rows of 16×16 cells), tones derived from
  `GLOBE_COLORS`; sprite index lookup per type/variant; dot size per sprite.
- `objectPoints.ts`: per-object static attributes (sprite row, dot size, base colour, visibility) and the
  prev/next position attributes, swapped ping-pong on each worker frame (one upload per tick).
- `objectMaterial.ts`: the ShaderMaterial (GPU interpolation, orientation sector, LOD dither, pixel snap,
  optional 3× scale and bracket for the selection).
- `picking.ts`: pure nearest-object search in screen space with Earth occlusion.
- `Picker.tsx`: pointer listeners on the canvas (click = moved < 5 px; hover throttled to 100 ms).
- `Selection.tsx`: the selected object at 3× with brackets, and its orbit path line.
- `Objects.tsx` keeps its props; `objectGeometries.ts`, `writeInstance` and `objectSize` are removed.
  `interpolate` stays for labels and fly-to.

## Data flow

- Worker tick (10 Hz): previous ← next (attribute swap, no upload); next ← new frame (one ~340 KB upload).
- Filter change: visibility attribute rewritten.
- Every frame: uniforms only (interpolation factor, LOD fade, pixel ratio, viewport).
- Orbit path: new worker request `{ kind: "path", id, index, centerMs, steps }` returns one orbital period
  (from mean motion) centred on `centerMs`, in scene coordinates; refreshed every ~10 s while selected.

## Picking

On click, interpolate every visible object of both groups at `simClock.now()`, project to CSS px, skip points
whose line of sight from the camera hits the Earth sphere first, choose the nearest within 8 px (16 px for touch;
ties go to the closer object). Hover uses the same search, throttled, and sets the pointer cursor. Clicking empty
space keeps today's behaviour (no deselect).

## Errors and edge cases

- Failed propagation writes NaN; the shader hides points whose position is not finite.
- Before the first worker frame, nothing is drawn and nothing is pickable.
- Objects behind the Earth: hidden by depth test; not pickable; the selection sprite hides too.
- Point-size limits: the largest point is the selection (about 56 CSS px); WebGL2 hardware supports far larger.

## Testing

- Unit: sprite rows are rectangular and use only `.LMD`; four rotations return the original; every sector grid fits
  a 16×16 cell; atlas pixels match the sprite at known cells; tones derive from `GLOBE_COLORS`; variant choice is
  deterministic; picking (nearest, radius, invisible skipped, occlusion, tie-break); worker path request returns
  one period of finite points.
- Existing unit and e2e suites stay green (search, fly-to, labels).
- Visual: screenshots at the default view and zoomed in, checked against the approved mockup.
- Performance: per-frame scripting time before and after, measured with the same page in headless Chromium.
