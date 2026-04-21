import { opencodeBaseUrl } from '@/lib/opencode/client';
import { LiveView } from './live-view';

export const dynamic = 'force-dynamic';

// Thin server wrapper: reads the opencode base URL from env, hands it to a
// client component that polls the proxy every 3s.
export default function OpencodeDebugPage() {
  return <LiveView baseUrl={opencodeBaseUrl()} />;
}
