import React from 'react';
import { ImportMatCode } from '../components/ImportMatCode';

export function ImportMatCodePage({ theme, project, active }: { theme: 'dark' | 'light'; project: string; active: boolean }) {
  return <ImportMatCode theme={theme} project={project} active={active} />;
}
