import { Chat } from "@/components/Chat";

// Edit these to match content/about.md.
const NAME = "[Your name]";
const ROLE = "AI engineer & full-stack developer";

export default function Home() {
  return (
    <main className="mx-auto grid w-full max-w-6xl flex-1 items-center gap-10 px-4 py-12 sm:px-6 lg:grid-cols-[1fr_1.1fr] lg:gap-16 lg:py-20">
      <div className="space-y-6">
        <p className="text-sm font-medium uppercase tracking-widest text-accent">{ROLE}</p>
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
          Hi, I&apos;m {NAME}. I build AI agents that bring businesses more customers.
        </h1>
        <p className="max-w-prose text-lg text-muted">
          This assistant is one of them. It knows my projects, services and process, and it cites
          where each answer comes from. Ask it whether I&apos;m the right fit for your project.
        </p>
        <ul className="flex flex-wrap gap-2 text-xs text-muted">
          {["Claude API", "Grounded answers with citations", "Streaming", "Prompt caching", "Next.js"].map((t) => (
            <li key={t} className="rounded-full border border-border px-3 py-1">
              {t}
            </li>
          ))}
        </ul>
      </div>
      <Chat />
    </main>
  );
}
