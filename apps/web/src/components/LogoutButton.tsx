"use client";

export default function LogoutButton() {
  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    window.location.href = "/login";
  }
  return (
    <button
      onClick={logout}
      className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-muted transition hover:border-bad-fg hover:text-bad-fg active:scale-95"
    >
      Log out
    </button>
  );
}
