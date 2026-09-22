import { AppNav } from "../../components/AppNav";

export default function AppShellLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="app-shell">
      <AppNav />
      <div className="app-body">{children}</div>
    </div>
  );
}
