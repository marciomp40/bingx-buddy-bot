import { useEffect, useState } from "react";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export function InstallAppButton() {
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [isIos, setIsIos] = useState(false);

  useEffect(() => {
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      // iOS Safari
      (navigator as unknown as { standalone?: boolean }).standalone === true;
    setInstalled(standalone);
    setIsIos(/iphone|ipad|ipod/i.test(navigator.userAgent));

    const onPrompt = (event: Event) => {
      event.preventDefault();
      setPromptEvent(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setPromptEvent(null);
      setShowHelp(false);
    };

    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (installed) return null;

  const handleClick = async () => {
    if (promptEvent) {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      if (choice.outcome === "accepted") setInstalled(true);
      setPromptEvent(null);
      return;
    }
    setShowHelp((v) => !v);
  };

  return (
    <div className="relative">
      <button
        onClick={handleClick}
        className="rounded-md border border-border bg-card px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:bg-accent"
      >
        Instalar no telefone
      </button>

      {showHelp && (
        <div className="absolute right-0 z-50 mt-2 w-64 rounded-md border border-border bg-card p-3 text-xs leading-relaxed text-muted-foreground shadow-lg">
          {isIos ? (
            <p>
              No iPhone, abra no Safari, toque em{" "}
              <span className="font-semibold text-foreground">Compartilhar</span> e escolha{" "}
              <span className="font-semibold text-foreground">Adicionar à Tela de Início</span>.
            </p>
          ) : (
            <p>
              Abra o menu do navegador (⋮) e toque em{" "}
              <span className="font-semibold text-foreground">Instalar aplicativo</span> ou{" "}
              <span className="font-semibold text-foreground">Adicionar à tela inicial</span>.
            </p>
          )}
          <button
            onClick={() => setShowHelp(false)}
            className="mt-2 text-[11px] font-semibold text-primary"
          >
            Fechar
          </button>
        </div>
      )}
    </div>
  );
}
