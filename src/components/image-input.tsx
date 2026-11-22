"use client";

import { useRef, useState } from "react";

const MAX_SIDE = 1200;

/** Downscales the chosen photo to ≤1200px WebP before the form submits. */
async function shrink(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) return file;
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size < 400_000) return file;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/webp", 0.82));
  if (!blob) return file;
  return new File([blob], file.name.replace(/\.\w+$/, "") + ".webp", { type: "image/webp" });
}

export function ImageInput({ name = "image" }: { name?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);

  return (
    <div className="space-y-1">
      <input
        ref={ref}
        type="file"
        name={name}
        accept="image/jpeg,image/png,image/webp"
        required
        className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-muted file:px-3 file:py-2 file:text-sm file:text-ink"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file || !ref.current) return;
          try {
            const small = await shrink(file);
            const dt = new DataTransfer();
            dt.items.add(small);
            ref.current.files = dt.files;
            setNote(`${Math.round(small.size / 1024)} KB, ready to upload`);
          } catch {
            setNote(null);
          }
        }}
      />
      {note && <p className="text-xs text-ink-soft">{note}</p>}
    </div>
  );
}
