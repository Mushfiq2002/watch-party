import { useEffect, useState } from "react";
import { Lobby } from "./components/Lobby";
import { RoomView } from "./components/RoomView";
import type { RoomStart } from "./lib/start";
import { loadName } from "./lib/storage";
import { ROOM_CODE_PATTERN } from "../shared/protocol";

type Screen =
  | { name: "setup" }
  | { name: "room"; code: string; start: RoomStart | null }
  | { name: "bad" };

function readScreen(): Screen {
  const match = window.location.pathname.match(/^\/r\/([A-Za-z0-9]+)$/i);
  if (!match) {
    return { name: "setup" };
  }
  const code = match[1].toUpperCase();
  if (!ROOM_CODE_PATTERN.test(code)) {
    return { name: "bad" };
  }
  return { name: "room", code, start: null };
}

export default function App() {
  const [screen, setScreen] = useState<Screen>(readScreen);

  useEffect(() => {
    const onPop = () => setScreen(readScreen());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  function openRoom(code: string, start: RoomStart | null) {
    const next = `/r/${code}`;
    if (`${window.location.pathname}${window.location.search}` !== next) {
      window.history.pushState({ watchParty: true }, "", next);
    }
    setScreen({ name: "room", code, start });
  }

  if (screen.name === "bad") {
    return (
      <main className="lobby">
        <div className="lobby-card">
          <h1>Unknown room</h1>
          <p className="lede">Room codes look like AB3K9.</p>
          <a className="primary" href="/">
            Back to lobby
          </a>
        </div>
      </main>
    );
  }

  if (screen.name === "room") {
    return <RoomView code={screen.code} start={screen.start} />;
  }

  return <Lobby initialName={loadName()} onEnter={openRoom} />;
}
