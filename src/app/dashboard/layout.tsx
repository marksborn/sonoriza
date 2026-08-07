import Link from "next/link";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      {children}
      <Link
        href="/dashboard/configuracao"
        className="fixed bottom-5 right-5 z-50 inline-flex items-center gap-2 rounded-2xl border border-violet-300/30 bg-[#241052]/95 px-4 py-3 text-sm font-black text-violet-100 shadow-[0_18px_45px_-20px_rgba(139,92,246,0.95)] backdrop-blur-xl transition hover:-translate-y-0.5 hover:border-violet-200/60 hover:bg-violet-800 sm:bottom-7 sm:right-7"
      >
        <span aria-hidden="true">⚙</span>
        Configurar
      </Link>
    </>
  );
}
