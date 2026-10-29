import { appVersion } from "@/lib/app-version";

const REPOSITORY_URL = "https://github.com/marksborn/sonoriza";

/** Small build identity so the user can tell which release is running. */
export function AppVersionFooter() {
  const version = appVersion();
  const commitDate = version.commitDate ? formatDate(version.commitDate) : null;

  return (
    <footer className="bg-canvas-dark px-5 pb-6 pt-2 text-center text-[11px] leading-5 text-muted-inverse/70 sm:px-8">
      <span>Sonoriza {version.version}</span>
      {version.sha && version.shortSha ? (
        <>
          {" · "}
          <a
            href={`${REPOSITORY_URL}/commit/${version.sha}`}
            target="_blank"
            rel="noreferrer"
            className="font-mono underline decoration-dotted underline-offset-2 hover:text-muted-inverse"
            title={version.sha}
          >
            {version.shortSha}
          </a>
        </>
      ) : (
        " · build local"
      )}
      {commitDate && <> · {commitDate}</>}
    </footer>
  );
}

function formatDate(value: Date) {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  }).format(value);
}
