import akinoMushiSource from '../user_presets/Aki-no-Mushi-7ch3_session.json?raw';
import filterAcid1Source from '../user_presets/Demo-Filter-Acid1_session.json?raw';
import filterAcid2Source from '../user_presets/Demo-Filter-Acid2_session.json?raw';

export const DEMO_SESSIONS = [
  { id: 'akino-mushi', name: 'Akino-mushi', source: akinoMushiSource },
  { id: 'filter-acid1', name: 'Filter-Acid1', source: filterAcid1Source },
  { id: 'filter-acid2', name: 'Filter-Acid2', source: filterAcid2Source },
] as const;

