/** Renders an SVG string (email chart builders) as inline markup. */
export function SvgMarkup({
  svg,
  className,
}: {
  svg: string;
  className?: string;
}) {
  const cleaned = svg.replace(/^<\?xml[^>]*>\s*/i, "").trim();
  return (
    <div
      className={className}
      dangerouslySetInnerHTML={{ __html: cleaned }}
    />
  );
}
