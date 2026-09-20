import fontSource from "../../../packages/brand/fonts/albert-sans.woff2";

export const palette = {
  bg: "#f7f6f2",
  surface: "#fffefa",
  accent: "#16284b",
  ink: "#16284b",
  muted: "#52647d",
  wash: "#e8e6df",
  error: "#963c3c",
};

const installed = new WeakSet<Document>();

export function installInboxFont(root: Document): void {
  if (installed.has(root) || typeof FontFace === "undefined" || !root.fonts) return;
  installed.add(root);
  const face = new FontFace("CargoLens Albert Sans", `url(${fontSource})`, {
    weight: "100 900",
    display: "swap",
  });
  void face.load().then((loaded) => root.fonts.add(loaded)).catch(() => undefined);
}
