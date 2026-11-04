# Graphics diagnosis and recovery

Moonweave 49 preserves the graphics diagnosis introduced in 46 and the typed Effect lifetimes introduced in 47. The Solid editor holds the graph; the stage holds the scene, camera and specimen; a graphics session owns its renderer and GPU-generated lighting. Restarting the graphics does not rebuild or replace the graph. Renderer attempts own their preparation resources, partial failures release what they acquired, and capture work is cancelled when its renderer lifetime ends. Geometry, atlas and painted-material construction all wait for successful context and renderer creation. Offline specimen selection stores an ID; a successful retry builds the latest selection once. Existing geometry survives renderer retries.

## What the old message actually meant

The earlier message meant that renderer startup had failed. It did not identify the cause. In the managed test browser used for release verification, the report records:

```text
webgl2API: true
status: unavailable
phase: context
GL_VENDOR = Disabled
GL_RENDERER = Disabled
```

The API name being present is not proof that a usable context can be created. This evidence describes that managed browser. It does not establish what happens in the user's own browser.

The atelier uses Three r187, whose `WebGLRenderer` requires WebGL2. Three removed WebGL1 support in r163. See the [official renderer documentation](https://threejs.org/docs/pages/WebGLRenderer.html).

## Read the failure before changing settings

Open **Graphics details** below the specimen. The report is generated locally and includes the app/engine versions, browser user agent, failure phase, browser creation message, available context settings and any shader logs. It contains no graph data and is not transmitted automatically.

| Status / phase | What is known | Next comparison |
| --- | --- | --- |
| `unavailable / context` | No usable WebGL2 context was obtained. | Read `creationMessage`; compare a regular browser tab and inspect browser graphics status. |
| `failed / renderer` | Context creation succeeded; the renderer constructor failed. | Copy the exception. This needs renderer/driver investigation. |
| `failed / prepare` | Renderer creation succeeded; lighting or viewport preparation failed. | Try reduced load to remove generated environment lighting and shadows. |
| `failed / shader` | A shader failed compilation or linking. | Compare Clay/Normals with Painted; retain the shader logs. |
| `failed / render` | A drawing operation threw an exception. | Compare Clay/Normals, reduce load, and retain the exception. |
| `failed / release` | Cleanup of an earlier renderer failed. | Copy the report; this is a lifecycle/application error. |
| `lost` | A previously available context was interrupted. | Rendering pauses; the composition stays editable while the browser restores the context. |
| `ready` | Renderer preparation and at least one frame completed without a reported shader/JavaScript failure. | Inspect the visible image; `ready` alone is not proof of visual correctness or frame rate. |

Browser creation errors can provide a platform-specific reason through `webglcontextcreationerror.statusMessage`; they can also provide no useful detail. See [MDN's event reference](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/webglcontextcreationerror_event). Three's [shader diagnostic hook](https://threejs.org/docs/pages/WebGLRenderer.html#debug) reports compilation/link failure separately.

## Recovery without losing the composition

**Retry preview** recreates the renderer on the existing canvas. The graph, material values, selected specimen, camera and source draft remain in the running application. The old renderer and generated lighting are released. A successful first frame enables Turntable and Save view.

**Try reduced load**, or **Use reduced load** in Graphics details, caps pixel ratio at 1 and disables shadow rendering and the generated environment. It retains the material graph and geometry. **Use full lighting** returns to the normal preview. This reduces rendering workload; it cannot enable an API disabled by browser policy or configuration.

When a working context is lost, the stage cancels pending rendering, stops the turntable, disables capture and preserves the editor. A restoration event restarts the renderer after Three's event handlers finish. Environment data is regenerated because it was produced on the GPU. Recovery requires the browser to restore the context; the application cannot promise that every lost context will return. Context-loss semantics and test support are specified by [Khronos](https://registry.khronos.org/webgl/specs/latest/1.0/#5.15.2) and the [WEBGL_lose_context extension](https://registry.khronos.org/webgl/extensions/WEBGL_lose_context/).

If a context exists but rendering fails, the **Clay** and **Normals** controls can retry with simple materials. This helps distinguish painted-material problems from geometry, camera or general renderer problems. A successful clay view does not by itself establish that the painted material is correct.

Capture is available only for a working live preview. It flushes pending edits, renders the requested frame, fixes the filename at capture time, prevents overlapping captures, and rejects a late callback after context loss, restart or disposal. The reference image cannot be exported as if it were the current view.

## Check the browser systematically

Change one variable at a time. Local autosave preserves the accepted graph, its Reset baseline and an unapplied source draft through reloads in the same browser. Export the graph for a portable copy before a restart or cross-browser comparison; in-place retry does not require reloading the page.

1. Open the published Moonweave URL in a regular browser tab and inspect Graphics details. Comparing an embedded/managed preview with a regular tab identifies an environment difference; it does not yet explain that difference.
2. If no context is available, inspect the browser's own graphics report.
3. If a context works, compare Painted, Clay and Normals, then compare full and reduced lighting.
4. Retain the report and the exact failing composition for an application or shader failure. Only the graphics report is copied by its button; export the graph separately when it is needed.

| Browser | Diagnostic route |
| --- | --- |
| Chrome | Type `chrome://gpu` in the address bar. Inspect WebGL/WebGL2 feature status and reported problems. In Settings → System, check graphics acceleration and restart after changing it. |
| Firefox | Open `about:support` → Graphics. Inspect driver and WebGL status, then review Settings → Performance. |
| Safari | Update Safari through the supported OS update path, restart, and isolate extension or site-specific problems. Safari does not use Chrome's Settings → System route. |

Sources: [Chrome graphics report guidance](https://developer.chrome.com/blog/supercharge-web-ai-testing), [Google graphics-acceleration instructions](https://support.google.com/a/users/answer/9282978), [Firefox troubleshooting information](https://support.mozilla.org/en-US/kb/use-troubleshooting-information-page-fix-firefox), [Firefox performance settings](https://support.mozilla.org/en-US/kb/performance-settings), and [Apple Safari troubleshooting](https://support.apple.com/en-us/102564).

## Alternative renderers and fallbacks

| Approach | Use | Tradeoff |
| --- | --- | --- |
| Current WebGL2 renderer with diagnosis/recovery | Preserve the existing surface rendering while handling failures accurately. | Requires a usable WebGL2 context. Implemented. |
| Reduced lighting | Reduce pixels and lighting work on an available renderer. | Cannot repair disabled graphics or every shader failure. Implemented. |
| Labeled reference image | Keep the intended appearance visible without browser 3D. | Static, identifies its preset/specimen, and does not reflect edits. Implemented. |
| Canvas2D swatch/atlas preview | Allow some live pigment inspection without WebGL. | A separate approximation; it would not reproduce creature geometry, triplanar projection or physical lighting. Not implemented. |
| WebGPU/TSL adapter | Provide another backend for the renderer-independent graph. | Requires new material lowering, availability checks and visual tests. Not implemented. |
| Explicit legacy WebGL1 adapter | Support an environment with only WebGL1. | Requires an older renderer and real extension/precision/visual compatibility work. Existing r140 injection tests do not prove this fallback. Not implemented. |
| Remote rendering | Render exact surfaces where client graphics are unavailable. | Requires a rendering service, latency/cost management and an interaction design. Not implemented. |

Three's [WebGPU migration guide](https://threejs.org/manual/pages/webgpurenderer) says its WebGPU renderer falls back to WebGL2, and does not support the existing `onBeforeCompile` material path. Moonweave would need a node-material/TSL backend. Replacing the renderer constructor is insufficient.

## Verification boundaries

The lifecycle unit tests use controlled canvas/context/renderer doubles to exercise failure, retry, loss, restoration and disposal ordering. They do not represent GPU rendering. The managed browser verifies the real blocked-context report, reference UI, retry/profile actions, report copying, and preservation of graph/source edits.

Revision 49's native shader verification compiles 24 programs and renders 22 cases on each of the sphere and shell specimens. All 40 pre-existing images are pixel-identical to revision 48, including patched/fresh graph and implicit/explicit frame comparisons. Four additional images exercise the new Directional finish example at near and far views. Separate stage tests establish zero geometry or atlas construction when context creation fails, deferred selection and geometry reuse across retries. These do not validate browser context recovery. Successful live browser rendering, actual `WEBGL_lose_context` recovery, live capture delivery and reduced/full lighting comparisons remain to be exercised in a browser with WebGL2 enabled. The release verification record reports this boundary explicitly.
