const STUB_URL = new URL("./note-store-firebase-stubs.mjs", import.meta.url).href;

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("https://www.gstatic.com/firebasejs/") && (
    specifier.endsWith("/firebase-firestore.js")
    || specifier.endsWith("/firebase-storage.js")
  )) {
    return { shortCircuit: true, url: STUB_URL };
  }
  return nextResolve(specifier, context);
}
