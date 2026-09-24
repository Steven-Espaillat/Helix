import type { ParityScreen } from "../types";

import { laneAScreens } from "./lane-a";
import { laneBScreens } from "./lane-b";
import { laneCScreens } from "./lane-c";
import { laneDScreens } from "./lane-d";
import { step0Screens } from "./step0";

// OWNER: step 0. Lanes edit only their own screens/lane-*.ts file.
export const SCREENS: ParityScreen[] = [
  ...step0Screens,
  ...laneAScreens,
  ...laneBScreens,
  ...laneCScreens,
  ...laneDScreens,
];

const ids = new Set<string>();
for (const screen of SCREENS) {
  if (ids.has(screen.id)) {
    throw new Error(`Duplicate parity screen id: ${screen.id}`);
  }
  ids.add(screen.id);
}
