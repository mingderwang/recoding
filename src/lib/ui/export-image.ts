/** Serialise a rendered score to a downloadable file. */

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Give the click a tick to start before the URL is invalidated.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * The VexFlow SVG as a standalone document.
 *
 * The music font is the part that needs care. VexFlow registers Bravura as an
 * `@font-face` in the *document*, but a saved SVG and a PNG rasterised through
 * an `<img>` both render in a context that never sees the document's styles:
 * the noteheads and clefs would silently come out blank or as fallback glyphs.
 * So the font is inlined into the SVG as its own `@font-face`, which makes the
 * file genuinely self-contained.
 */
export function serializeSvg(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const box = svg.viewBox.baseVal;
  const width = box.width || svg.clientWidth || 800;
  const height = box.height || svg.clientHeight || 200;

  // Two sources of an xmlns declaration collide here. The element is already
  // in the SVG namespace, so XMLSerializer emits xmlns on its own — and VexFlow
  // additionally sets it as a plain attribute. Serialising both yields a
  // duplicate `xmlns` attribute, which is a hard XML parse error and makes the
  // exported file unopenable. Remove the plain-attribute copy and let the
  // serializer supply the real one.
  if (clone.getAttribute('xmlns') !== null) {
    clone.removeAttribute('xmlns');
  }
  if (clone.getAttribute('xmlns:xlink') !== null) {
    clone.removeAttribute('xmlns:xlink');
  }

  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));

  const namespace = 'http://www.w3.org/2000/svg';
  const defs = document.createElementNS(namespace, 'defs');
  const style = document.createElementNS(namespace, 'style');
  style.textContent = fontFaceCss();
  defs.appendChild(style);

  const background = document.createElementNS(namespace, 'rect');
  background.setAttribute('x', '0');
  background.setAttribute('y', '0');
  background.setAttribute('width', String(width));
  background.setAttribute('height', String(height));
  background.setAttribute('fill', '#ffffff');

  clone.insertBefore(background, clone.firstChild);
  clone.insertBefore(defs, clone.firstChild);

  const markup = new XMLSerializer().serializeToString(clone);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${markup}`;
}

/** The music font as an embeddable @font-face rule. */
function fontFaceCss(): string {
  const url = musicFontUrl();
  return [
    '@font-face {',
    "  font-family: 'Bravura';",
    `  src: url('${url}') format('woff2');`,
    '}',
  ].join('\n');
}

/**
 * VexFlow keeps the font URL in the document it loaded. Reading it back out is
 * how the export stays in sync with whatever VexFlow actually loaded, instead
 * of duplicating a 300KB base64 blob into this source file.
 *
 * Two sources are tried. The CSSOM is authoritative in a real browser, but a
 * @font-face's `src` is not guaranteed to survive CSS parsing in every
 * implementation, so the raw text of any inline <style> is used as a fallback.
 * Returning '' would ship an SVG with an empty font URL and blank noteheads, so
 * a URL that does not look like a data URL is treated as a failure.
 */
function musicFontUrl(): string {
  const pattern = /src\s*:\s*url\((['"]?)(data:[^)'"]+)\1\)/i;

  for (const sheet of Array.from(document.styleSheets)) {
    let text: string;
    try {
      text = Array.from(sheet.cssRules)
        .map((rule) => rule.cssText)
        .join('\n');
    } catch {
      continue; // cross-origin stylesheet
    }
    if (!/bravura/i.test(text)) continue;
    const match = pattern.exec(text);
    if (match) return match[2];
  }

  // Fall back to the literal text of inline stylesheets, which is what a
  // minimal CSS implementation still preserves.
  for (const style of Array.from(document.querySelectorAll('style'))) {
    const text = style.textContent ?? '';
    if (!/bravura/i.test(text)) continue;
    const match = pattern.exec(text);
    if (match) return match[2];
  }
  return '';
}

export function downloadSvg(svg: SVGSVGElement, filename: string): void {
  downloadBlob(new Blob([serializeSvg(svg)], { type: 'image/svg+xml;charset=utf-8' }), filename);
}

/**
 * Rasterise the SVG to PNG.
 *
 * The score font (Bravura) ships inside the bundle as base64 rather than as a
 * separate file, so the SVG is self-contained and drawing it to a canvas does
 * not taint it. Converting via a data URL rather than a blob URL keeps that
 * true in every browser.
 */
export async function svgToPngBlob(svg: SVGSVGElement, scale = 2): Promise<Blob> {
  const markup = serializeSvg(svg);
  const box = svg.viewBox.baseVal;
  const width = box.width || svg.clientWidth || 800;
  const height = box.height || svg.clientHeight || 200;

  const encoded = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  const image = await loadImage(encoded);

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('could not create a 2D canvas context');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('could not encode the score as PNG'));
    }, 'image/png');
  });
}

export async function downloadPng(svg: SVGSVGElement, filename: string): Promise<void> {
  downloadBlob(await svgToPngBlob(svg), filename);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('could not render the score image'));
    image.src = src;
  });
}
