/**
 * Cluster-aware Health Status
 * Reports this node's status and cluster membership info.
 */

import { getClusterConfig } from './config';

export interface NodeHealth {
  nodeId: string;
  status: 'ok';
  uptime: number;
  timestamp: string;
  cluster: {
    enabled: boolean;
    nodeId: string;
    discoveryUrl?: string;
  };
}

export function getNodeHealth(): NodeHealth {
  const cluster = getClusterConfig();
  return {
    nodeId: cluster.nodeId,
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    cluster: {
      enabled: cluster.enabled,
      nodeId: cluster.nodeId,
      discoveryUrl: cluster.discoveryUrl,
    },
  };
}
