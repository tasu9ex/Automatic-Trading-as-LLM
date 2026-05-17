import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function Home() {
  return (
    <main className="container mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <h1 className="font-bold text-2xl">LLM Trading</h1>
        <Badge variant="outline">Phase A: scaffolding</Badge>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>System Status</CardTitle>
          <CardDescription>Not yet wired to backend</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-sm">State</span>
            <Badge>stopped</Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-sm">Portfolio</span>
            <span className="font-mono">¥250,000</span>
          </div>
          <div className="flex gap-2 pt-2">
            <Button disabled>Start</Button>
            <Button variant="outline" disabled>
              Stop
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
