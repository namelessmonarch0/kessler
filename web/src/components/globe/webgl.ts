// three 0.186's WebGLRenderer only ever requests a "webgl2" context and throws if none is
// available (node_modules/three/src/renderers/WebGLRenderer.js), so a WebGL1-only device must
// still be treated as unsupported here to avoid a crash instead of the fallback UI.
export function hasWebGL(doc: Pick<Document, "createElement"> = document): boolean {
  try {
    const canvas = doc.createElement("canvas") as HTMLCanvasElement;
    return Boolean(canvas.getContext("webgl2"));
  } catch {
    return false;
  }
}
