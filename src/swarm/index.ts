/**
 * AgentX — Swarm Module Exports
 * 
 * Phase D: Multi-Agent Swarm system.
 * - TaskQueue: priority-based work distribution
 * - AgentSpawner: child process management
 * - SwarmCoordinator: high-level orchestration
 * - RuFloBridge: RuFlo + AgentX integration
 * - RuFloStatusReporter: Status sync between RuFlo and AgentX
 */

export { TaskQueue, type Task, type TaskDefinition, type TaskPriority, type TaskStatus, type TaskQueueStats } from './task-queue.js';
export { AgentSpawner, type SwarmAgent, type AgentConfig, type AgentStatus, type AgentMessage, type AgentResponse } from './spawner.js';
export { SwarmCoordinator, type CoordinatorConfig, type SwarmResult, type SwarmStatusEntry } from './coordinator.js';
export { RuFloBridge, type RuFloAgent, type RuFloTask, type BridgeConfig, type BridgeResult } from './ruflo-bridge.js';
export { RuFloStatusReporter, getStatusReporter, type WorkerStatus, type TaskStatus as RuFloTaskStatus } from './ruflo-status-reporter.js';
