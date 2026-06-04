import React from 'react';
import { MatFigExport } from '../components/MatFigExport';
import { PinnedPoint } from '../components/ESS20Tool';
import { Ess20ProjectId } from '../lib/ess20-engine';

export function MatFigExportPage({ theme, project, active }: { theme: 'dark' | 'light'; project: string; active: boolean }) {
  const projectId = (project.startsWith("SNTB") ? "SNTB" : "SNTV") as Ess20ProjectId;
  const [pinnedPoints, setPinnedPoints] = React.useState<PinnedPoint[]>([]);
  return <MatFigExport theme={theme} result={null} projectId={projectId} active={active} pinnedPoints={pinnedPoints} setPinnedPoints={setPinnedPoints} />;
}
