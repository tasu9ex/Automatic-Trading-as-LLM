/**
 * A: navigation loading state。dashboard / cycle 詳細など SSR フェッチ中の白画面を防ぐ。
 * Next.js が route segment ごとに自動で挟む (app router の loading.tsx 規約)。
 */
export default function Loading() {
  return (
    <main className="container mx-auto flex min-h-screen max-w-5xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div className="h-7 w-40 animate-pulse rounded-md bg-muted" />
        <div className="h-7 w-20 animate-pulse rounded-md bg-muted" />
      </div>
      <div className="h-32 animate-pulse rounded-md bg-muted/60" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-20 animate-pulse rounded-md bg-muted/60" />
        ))}
      </div>
      <div className="h-40 animate-pulse rounded-md bg-muted/60" />
    </main>
  );
}
