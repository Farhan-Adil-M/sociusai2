// Serverless polyfills for pdf.js (pdf-parse) in Node < 26 where the browser
// globals are absent. Text extraction never renders, so empty class stubs are
// enough — this file ONLY exists so it is imported before app.js loads pdf-parse.
globalThis.DOMMatrix ??= class DOMMatrix {};
globalThis.ImageData ??= class ImageData {};
globalThis.Path2D ??= class Path2D {};
