import { memo, useMemo, useState, type ReactNode, isValidElement } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { FILE_LINK_TAG, remarkFileLinks, resolveFileRef } from "./file-links";
import { FileLink, useFileLinks, type FileLinksValue } from "./FileLinks";

/** Text of a React subtree: what a code block's children flatten to. */
function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

export function CopyButton({ text, className, label = "Copy" }: { text: string; className?: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      aria-label={label}
      title={label}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        });
      }}
      className={cn("flex size-5 items-center justify-center rounded text-fg-faint outline-none transition-colors hover:bg-active hover:text-fg", className)}
    >
      {done ? <Check className="size-3 text-green animate-pop" /> : <Copy className="size-3" />}
    </button>
  );
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  return (
    <div className="group/code my-2 overflow-hidden rounded-lg border border-line bg-raised">
      <div className="flex h-6 items-center justify-between border-b border-line px-2.5">
        <span className="font-mono text-[10px] uppercase tracking-wider text-fg-faint">{lang || "text"}</span>
        <CopyButton text={code} className="opacity-0 transition-opacity group-hover/code:opacity-100 focus-visible:opacity-100" label="Copy code" />
      </div>
      <pre className="m-0 overflow-x-auto px-3 py-2.5 font-mono text-[12px] leading-[1.55]">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** The renderers; `links` (null outside a FileLinkScope) decides what a link to a workspace file turns into. */
function componentsFor(links: FileLinksValue | null): Components {
  // `file-link` is not an HTML tag, so it is outside the Components type; remarkFileLinks emits it.
  const custom = {
    [FILE_LINK_TAG]: (props: Record<string, unknown>) => (
      <FileLink path={String(props["data-path"] ?? "")} line={Number(props["data-line"]) || undefined} col={Number(props["data-col"]) || undefined}>
        {props.children as ReactNode}
      </FileLink>
    ),
  };
  return {
    ...(custom as Components),
    // Links open outside the app: the page must never navigate away from the daemon's origin. A link whose target
    // is a file in the workspace (`[x](src/a.ts#L9)`, an absolute path, file://) opens it in the editor instead,
    // and one that is neither a file nor a URL (so it would only reach a 404 on the daemon) is left as text.
    a: ({ href, children }) => {
      const ref = href && links && !/^(https?:|mailto:|#|\/\/)/i.test(href) ? resolveFileRef(safeDecode(href), links.index, links.cwd) : null;
      if (ref) return <FileLink path={ref.path} line={ref.line} col={ref.col}>{children}</FileLink>;
      if (!href || (links && !/^(https?:|mailto:|#|\/\/)/i.test(href))) return <span>{children}</span>;
      return (
        <a href={href} target="_blank" rel="noopener noreferrer nofollow">
          {children}
        </a>
      );
    },
    pre: ({ children }) => {
      const child = Array.isArray(children) ? children[0] : children;
      const props = (isValidElement(child) ? child.props : {}) as { className?: string; children?: ReactNode };
      const lang = /language-([\w+-]+)/.exec(props.className ?? "")?.[1] ?? "";
      return <CodeBlock lang={lang} code={textOf(props.children).replace(/\n$/, "")} />;
    },
    table: ({ children }) => (
      <div className="my-2 overflow-x-auto">
        <table>{children}</table>
      </div>
    ),
  };
}

const noLinks = componentsFor(null);

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// file: links are kept (react-markdown drops them by default) so an agent's `[a.ts](file:///…/a.ts)` can open the file.
const urlTransform = (u: string) => (/^file:/i.test(u) ? u : defaultUrlTransform(u));

/**
 * Assistant prose. react-markdown renders to React elements (no innerHTML) and raw HTML is not enabled, so
 * agent output cannot inject markup; `urlTransform` drops javascript: links (file: is the one scheme added). Inside a
 * FileLinkScope, mentions of real workspace files (inline code, plain text, links) become buttons that open the editor.
 */
export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  const links = useFileLinks();
  const components = useMemo(() => (links ? componentsFor(links) : noLinks), [links]);
  const plugins = useMemo(() => (links ? ([remarkGfm, [remarkFileLinks, { index: links.index, cwd: links.cwd }]] as never) : [remarkGfm]), [links]);
  return (
    <div className={cn("markdown [&_ol]:list-decimal [&_ul]:list-disc", className)}>
      <ReactMarkdown remarkPlugins={plugins} components={components} urlTransform={urlTransform}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
