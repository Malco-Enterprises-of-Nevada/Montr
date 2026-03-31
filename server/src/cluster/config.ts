/**
 * Cluster Configuration
 * Defines settings for multi-server clustering mode.
 */

import crypto from 'crypto';

export interface ClusterConfig {
  enabled: boolean;
  nodeId: string;
  discoveryUrl?: string;
  redisUrl?: string;
}

let clusterConfig: ClusterConfig | null = null;

export function getClusterConfig(): ClusterConfig {
  if (!clusterConfig) {
    clusterConfig = {
      enabled: process.env.CLUSTER_ENABLED === 'true',
      nodeId: process.env.CLUSTER_NODE_ID || crypto.randomUUID().substring(0, 8),
      discoveryUrl: process.env.CLUSTER_DISCOVERY_URL,
      redisUrl: process.env.CLUSTER_REDIS_URL,
    };
  }
  return clusterConfig;
}
