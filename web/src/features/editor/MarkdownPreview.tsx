import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { url } from "@/lib/api";
import { dirname } from "@/lib/utils";
import { resolveRelative } from "./mdPaths";

/** Rendered markdown for a file in the workspace. No raw HTML is ever interpreted; images in the repo load through the raw endpoint. */
export function MarkdownPreview({ text, root, path }: { text: string; root: string; path: string }) {
  const dir = dirname(path);
  return (
    <div className="h-full overflow-auto">
      <div className="markdown mx-auto max-w-[820px] px-8 py-6 [&_h1]:border-b [&_h1]:border-line [&_h1]:pb-2 [&_h1]:text-[1.7em] [&_h2]:text-[1.35em] [&_li::marker]:text-fg-faint [&_ol]:list-decimal [&_ul]:list-disc">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ href, children }) => (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ),
            img: ({ src, alt }) => {
              const rel = typeof src === "string" ? resolveRelative(dir, src) : null;
              return <img src={rel !== null ? url.fs(root, "raw", { path: rel }) : typeof src === "string" ? src : undefined} alt={alt ?? ""} className="max-w-full rounded-md" loading="lazy" />;
            },
          }}
        >
          {text}
        </ReactMarkdown>
      </div>
    </div>
  );
}

/** An SVG shown from the buffer's own text: an <img> never runs the script inside it. */
export function SvgPreview({ text }: { text: string }) {
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
  return (
    <div className="flex h-full items-center justify-center overflow-auto bg-[conic-gradient(var(--raised)_25%,transparent_0_50%,var(--raised)_0_75%,transparent_0)] bg-[length:16px_16px] p-8">
      <img src={src} alt="SVG preview" className="max-h-full max-w-full" />
    </div>
  );
}
