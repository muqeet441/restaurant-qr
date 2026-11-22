import type { MetadataRoute } from "next";

/** Lets waiter tablets and kitchen screens "install" the app full-screen (PWA). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "TableQR",
    short_name: "TableQR",
    description: "QR ordering and restaurant operations",
    start_url: "/staff",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#f6f5f2",
    theme_color: "#c2410c",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon-maskable.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
  };
}
