import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Camera, ChevronLeft, ChevronRight, ImageOff, Paperclip, X } from "lucide-react";
import type { ActivityImage } from "@/hooks/useDashboardState";

// Thumbnail strip for the images a prompt or capture carries, with a
// click-to-expand lightbox. The bytes are served by the Murmur server at the
// image's relative `url`, so the dashboard loads them lazily from the same
// origin. A failed load collapses the thumbnail to a small placeholder rather
// than showing a broken-image glyph.

function sourceIcon(source: ActivityImage["source"]): React.JSX.Element {
  return source === "tool" ? (
    <Camera className="h-3 w-3" />
  ) : (
    <Paperclip className="h-3 w-3" />
  );
}

function Thumb({
  image,
  onOpen,
}: {
  image: ActivityImage;
  onOpen: () => void;
}): React.JSX.Element {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span
        className="flex h-16 w-16 shrink-0 items-center justify-center rounded-md bg-white/[0.03] text-zinc-600 ring-1 ring-inset ring-white/10"
        title="Image unavailable"
      >
        <ImageOff className="h-4 w-4" />
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group relative inline-flex h-16 min-w-[2.5rem] max-w-[16rem] shrink-0 items-center justify-center overflow-hidden rounded-md bg-white/[0.02] ring-1 ring-inset ring-white/10 transition hover:ring-white/30 focus:outline-none focus:ring-2 focus:ring-blue-400/60"
      title={image.source === "tool" ? "Tool capture — click to expand" : "Attachment — click to expand"}
    >
      <img
        src={image.url}
        alt={image.alt ?? (image.source === "tool" ? "tool capture" : "prompt attachment")}
        loading="lazy"
        onError={() => setFailed(true)}
        className="h-full w-auto max-w-full object-contain transition group-hover:scale-[1.03]"
      />
      <span className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded bg-zinc-950/70 text-zinc-200">
        {sourceIcon(image.source)}
      </span>
    </button>
  );
}

function Lightbox({
  images,
  index,
  onClose,
  onIndex,
}: {
  images: ActivityImage[];
  index: number;
  onClose: () => void;
  onIndex: (next: number) => void;
}): React.JSX.Element {
  const count = images.length;
  const go = useCallback(
    (delta: number) => onIndex((index + delta + count) % count),
    [index, count, onIndex]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" && count > 1) go(1);
      else if (e.key === "ArrowLeft" && count > 1) go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, go, count]);

  const current = images[index];
  if (!current) return <></>;

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-zinc-950/85 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-zinc-200 ring-1 ring-inset ring-white/15 transition hover:bg-white/20"
        aria-label="Close"
      >
        <X className="h-5 w-5" />
      </button>
      {count > 1 && (
        <>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              go(-1);
            }}
            className="absolute left-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-zinc-200 ring-1 ring-inset ring-white/15 transition hover:bg-white/20"
            aria-label="Previous"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              go(1);
            }}
            className="absolute right-16 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-zinc-200 ring-1 ring-inset ring-white/15 transition hover:bg-white/20"
            aria-label="Next"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </>
      )}
      <figure
        className="flex max-h-full max-w-full flex-col items-center gap-2"
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={current.url}
          alt={current.alt ?? "image"}
          className="max-h-[80vh] max-w-[85vw] rounded-lg object-contain shadow-2xl ring-1 ring-white/10"
        />
        <figcaption className="flex items-center gap-1.5 text-xs text-zinc-400">
          {sourceIcon(current.source)}
          <span>
            {current.source === "tool" ? "Tool capture" : "Prompt attachment"}
            {count > 1 ? ` — ${index + 1} of ${count}` : ""}
          </span>
        </figcaption>
      </figure>
    </div>,
    document.body
  );
}

export function ActivityImages({
  images,
  className,
}: {
  images: ActivityImage[];
  className?: string;
}): React.JSX.Element | null {
  const [open, setOpen] = useState<number | null>(null);
  if (!images || images.length === 0) return null;
  return (
    <div className={`flex flex-wrap gap-1.5 ${className ?? ""}`}>
      {images.map((img, i) => (
        <Thumb key={img.id} image={img} onOpen={() => setOpen(i)} />
      ))}
      {open !== null && (
        <Lightbox
          images={images}
          index={open}
          onClose={() => setOpen(null)}
          onIndex={setOpen}
        />
      )}
    </div>
  );
}
