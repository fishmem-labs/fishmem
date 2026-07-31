export function CodeBlock({
  label,
  code,
  language = "bash"
}: {
  label?: string;
  code: string;
  language?: string;
}) {
  const lines = code.trim().split("\n");
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-[#101113] text-[#eef2f1] code-glow">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2 text-xs text-white/60">
        <span>{language}</span>
        {label ? <span>{label}</span> : null}
      </div>
      <pre className="overflow-x-auto p-4 text-sm leading-6">
        <code>
          {lines.map((line, index) => (
            <span key={`${line}-${index}`} className="block">
              <span className="mr-4 select-none text-white/30">{index + 1}</span>
              {line}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
