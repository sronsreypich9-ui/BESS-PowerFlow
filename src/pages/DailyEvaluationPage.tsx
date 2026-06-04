import React from 'react';
import { ESS20Tool } from '../components/ESS20Tool';

export function DailyEvaluationPage({ theme, project, active, progress, setProgress, auditStateVersion }: { theme: 'dark' | 'light'; project: string; active: boolean; progress: any; setProgress: any; auditStateVersion: number }) {
  return <ESS20Tool theme={theme} project={project} active={active} progress={progress} setProgress={setProgress} auditStateVersion={auditStateVersion} />;
}

