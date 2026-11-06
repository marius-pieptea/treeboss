import { navigate } from "@/lib/nav";
import { emptyWs, useUi, withTabOpened, type FactoryPage } from "@/lib/store";

/** Open the factory tab on a sub-page. Without one, it opens on the page it was last on. */
export function openFactory(page?: FactoryPage): void {
  const ui = useUi.getState();
  const open = ui.current ? ui.byWs[ui.current]?.tabs.find((t) => t.kind === "factory") : undefined;
  ui.openTab({ kind: "factory", page: page ?? (open?.kind === "factory" ? open.page : "portfolio"), title: "Factory" });
}

/**
 * Switch the app to another workspace, the same way the title bar's switcher does (`/w/:id`). With a page, that
 * workspace's factory tab is set to it first, so the switch lands on the factory page the user was on.
 */
export function switchWorkspace(id: string, page?: FactoryPage): void {
  if (page) {
    useUi.setState((s) => ({
      byWs: { ...s.byWs, [id]: withTabOpened(s.byWs[id] ?? emptyWs(), { kind: "factory", page, title: "Factory" }) },
    }));
  }
  navigate(`/w/${id}`);
}
