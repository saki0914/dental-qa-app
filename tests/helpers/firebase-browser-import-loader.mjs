const FIREBASE_BROWSER_IMPORTS = new Map([
  ["firebase-firestore.js", "firebase/firestore"],
  ["firebase-storage.js", "firebase/storage"]
]);

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("https://www.gstatic.com/firebasejs/")) {
    const filename = new URL(specifier).pathname.split("/").pop();
    const replacement = FIREBASE_BROWSER_IMPORTS.get(filename);
    if (replacement) return nextResolve(replacement, context);
  }
  return nextResolve(specifier, context);
}
