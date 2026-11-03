import { useCallback } from "react";

const emailHead = [
  "<!doctype html><html><head>",
  '<meta charset="utf-8">',
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline' https:; font-src https: data:">`,
  '<meta name="referrer" content="no-referrer">',
  '<meta name="color-scheme" content="light">',
  '<base target="_blank">',
  "<style>:root:root,:root:root>body{height:auto!important;min-height:0!important;margin:0}</style>",
  "</head><body>",
].join("");

export const emailSandbox = "allow-same-origin allow-popups allow-popups-to-escape-sandbox";

export const emailDocument = (html: string) => `${emailHead}${html}`;

export function Email({ html, title }: { html: string; title: string }) {
  const fit = useCallback((frame: HTMLIFrameElement) => {
    const measure = () => {
      const page = frame.contentDocument;
      if (page === null) return;
      frame.style.removeProperty("--email-w");
      const lane = frame.clientWidth;
      const natural = page.documentElement.scrollWidth;
      if (natural > lane) {
        frame.style.setProperty("--email-w", `${natural}px`);
        frame.style.setProperty("--email-scale", String(lane / natural));
      } else {
        frame.style.removeProperty("--email-scale");
      }
      const height = Math.max(
        page.documentElement.getBoundingClientRect().height,
        page.body?.scrollHeight ?? 0,
      );
      frame.style.setProperty("--email-h", `${Math.ceil(height)}px`);
    };
    const observer = new ResizeObserver(measure);
    const loaded = () => {
      measure();
      observer.disconnect();
      if (frame.parentElement !== null) observer.observe(frame.parentElement);
      const page = frame.contentDocument;
      if (page !== null) observer.observe(page.documentElement);
    };
    frame.addEventListener("load", loaded);
    return () => {
      observer.disconnect();
      frame.removeEventListener("load", loaded);
    };
  }, []);
  return (
    <iframe
      data-email
      title={title}
      srcDoc={emailDocument(html)}
      sandbox={emailSandbox}
      referrerPolicy="no-referrer"
      className="block border-none"
      ref={fit}
    />
  );
}
