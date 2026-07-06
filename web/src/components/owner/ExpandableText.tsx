// Renders text in full. By product direction we do not truncate or add a
// more/less toggle for now: the owner sees the whole message. Line breaks are
// preserved and long unbroken tokens wrap instead of overflowing.
export function ExpandableText({
  text,
  className,
}: {
  text: string;
  className?: string;
}): React.JSX.Element {
  return <span className={`${className ?? ""} whitespace-pre-wrap break-words`.trim()}>{text}</span>;
}
