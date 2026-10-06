// Production stages for the web app. The definitions live in shared/stages.ts (also used by the server).
import { MAP_ACTIONS, STAGES, stepperSteps } from '@shared/stages';

export { STAGES, stageIndex, stageLabel, stepperSteps as fallbackStepper } from '@shared/stages';

const ACTION_LABEL: Record<(typeof MAP_ACTIONS)[number], string> = {
  hold: 'Put the case on hold',
  cancelled: 'Cancel the case',
  ignore: 'Ignore this code',
};

/** Targets a stage map row may point to. */
export const MAP_TARGETS: readonly { id: string; label: string }[] = [
  ...STAGES,
  ...MAP_ACTIONS.map((id) => ({ id, label: ACTION_LABEL[id] })),
];
