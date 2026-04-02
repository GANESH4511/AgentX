/**
 * Task Decomposer - LLM-based task breakdown for dynamic agent spawning
 * 
 * Analyzes task complexity and breaks it into subtasks,
 * mapping each subtask to an appropriate agent type.
 */

import { LLMProvider } from '../providers/base.js';

export interface Subtask {
    id: string;
    description: string;
    agentType: AgentType;
    priority: number;
    dependencies: string[];
}

export type AgentType = 
    | 'coder'      // Write code
    | 'tester'     // Write tests
    | 'reviewer'   // Code review
    | 'researcher' // Find patterns/docs
    | 'planner'    // Architecture decisions
    | 'debugger'   // Fix issues
    | 'documenter' // Write docs
    | 'refactorer' // Improve code structure
    | 'security'   // Security audit
    | 'devops';    // CI/CD, deployment

export interface DecompositionResult {
    originalTask: string;
    complexity: 'simple' | 'moderate' | 'complex';
    subtasks: Subtask[];
    estimatedDuration: string;
    recommendedAgents: number;
}

const DECOMPOSITION_PROMPT = `You are a task decomposition expert. Analyze the following task and break it down into subtasks.

TASK: {task}

Analyze the complexity and break it into subtasks. For each subtask:
1. Assign an agent type: coder, tester, reviewer, researcher, planner, debugger, documenter, refactorer, security, devops
2. Set priority (1-10, where 10 is highest)
3. List dependencies (IDs of subtasks that must complete first)

RULES:
- Simple tasks (create file, fix typo): 1-2 subtasks
- Moderate tasks (add feature, refactor function): 3-5 subtasks
- Complex tasks (build app, major refactor): 6-15 subtasks
- Maximum 15 subtasks
- Always include at least a coder task
- Include tester task for any code changes
- Include reviewer for complex tasks

Respond in JSON format:
{
  "complexity": "simple|moderate|complex",
  "subtasks": [
    {
      "id": "subtask-1",
      "description": "What this subtask does",
      "agentType": "coder|tester|...",
      "priority": 1-10,
      "dependencies": []
    }
  ],
  "estimatedDuration": "5m|30m|2h|etc"
}

Only output valid JSON, no explanation.`;

export class TaskDecomposer {
    private maxAgents: number;
    private provider: LLMProvider;

    constructor(provider: LLMProvider, maxAgents: number = 15) {
        this.provider = provider;
        this.maxAgents = maxAgents;
    }

    /**
     * Decompose a task into subtasks using LLM analysis
     */
    async decompose(task: string): Promise<DecompositionResult> {
        const prompt = DECOMPOSITION_PROMPT.replace('{task}', task);

        try {
            // Call LLM to analyze task
            const messages = [
                { role: 'user' as const, content: prompt }
            ];

            let response = '';
            const stream = this.provider.chat(messages, {
                model: this.provider.getDefaultModel(),
                temperature: 0.3,  // Low temperature for consistent output
                maxTokens: 2000,
            });

            for await (const chunk of stream) {
                if (chunk.content) {
                    response += chunk.content;
                }
            }

            // Parse JSON response
            const parsed = this.parseResponse(response);
            
            // Apply constraints
            const constrained = this.applyConstraints(parsed, task);
            
            return constrained;
        } catch (error) {
            // Fallback to simple decomposition
            return this.fallbackDecomposition(task);
        }
    }

    /**
     * Parse LLM response into structured result
     */
    private parseResponse(response: string): Partial<DecompositionResult> {
        // Extract JSON from response (handle markdown code blocks)
        let jsonStr = response;
        
        const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (jsonMatch) {
            jsonStr = jsonMatch[1];
        }

        // Try to find JSON object
        const objMatch = jsonStr.match(/\{[\s\S]*\}/);
        if (objMatch) {
            jsonStr = objMatch[0];
        }

        try {
            return JSON.parse(jsonStr);
        } catch {
            return {};
        }
    }

    /**
     * Apply constraints to ensure valid output
     */
    private applyConstraints(parsed: Partial<DecompositionResult>, task: string): DecompositionResult {
        const subtasks = parsed.subtasks || [];
        const complexity = parsed.complexity || this.inferComplexity(task);
        
        // Ensure at least one coder subtask
        if (!subtasks.some(s => s.agentType === 'coder')) {
            subtasks.unshift({
                id: 'subtask-main',
                description: task,
                agentType: 'coder',
                priority: 10,
                dependencies: [],
            });
        }

        // Limit to maxAgents
        const limitedSubtasks = subtasks.slice(0, this.maxAgents);

        // Assign IDs if missing
        limitedSubtasks.forEach((s, i) => {
            if (!s.id) s.id = `subtask-${i + 1}`;
            if (!s.priority) s.priority = 10 - i;
            if (!s.dependencies) s.dependencies = [];
        });

        return {
            originalTask: task,
            complexity,
            subtasks: limitedSubtasks,
            estimatedDuration: parsed.estimatedDuration || this.estimateDuration(complexity),
            recommendedAgents: limitedSubtasks.length,
        };
    }

    /**
     * Infer complexity from task text
     */
    private inferComplexity(task: string): 'simple' | 'moderate' | 'complex' {
        const lower = task.toLowerCase();
        
        // Complex indicators
        const complexKeywords = ['build', 'create app', 'refactor', 'migrate', 'architecture', 'system', 'full'];
        if (complexKeywords.some(k => lower.includes(k))) {
            return 'complex';
        }

        // Simple indicators
        const simpleKeywords = ['fix', 'typo', 'update', 'change', 'rename', 'delete', 'remove', 'simple', 'quick'];
        if (simpleKeywords.some(k => lower.includes(k))) {
            return 'simple';
        }

        return 'moderate';
    }

    /**
     * Estimate duration based on complexity
     */
    private estimateDuration(complexity: 'simple' | 'moderate' | 'complex'): string {
        switch (complexity) {
            case 'simple': return '2-5 minutes';
            case 'moderate': return '10-30 minutes';
            case 'complex': return '1-2 hours';
        }
    }

    /**
     * Fallback decomposition when LLM fails
     */
    private fallbackDecomposition(task: string): DecompositionResult {
        const complexity = this.inferComplexity(task);
        const subtasks: Subtask[] = [];

        // Always have a coder
        subtasks.push({
            id: 'subtask-code',
            description: `Implement: ${task}`,
            agentType: 'coder',
            priority: 10,
            dependencies: [],
        });

        // Add tester for non-trivial tasks
        if (complexity !== 'simple') {
            subtasks.push({
                id: 'subtask-test',
                description: `Write tests for: ${task}`,
                agentType: 'tester',
                priority: 8,
                dependencies: ['subtask-code'],
            });
        }

        // Add more agents for complex tasks
        if (complexity === 'complex') {
            subtasks.push({
                id: 'subtask-plan',
                description: `Plan architecture for: ${task}`,
                agentType: 'planner',
                priority: 9,
                dependencies: [],
            });
            subtasks.push({
                id: 'subtask-review',
                description: `Review implementation of: ${task}`,
                agentType: 'reviewer',
                priority: 7,
                dependencies: ['subtask-code'],
            });
        }

        return {
            originalTask: task,
            complexity,
            subtasks,
            estimatedDuration: this.estimateDuration(complexity),
            recommendedAgents: subtasks.length,
        };
    }

    /**
     * Quick complexity check (no LLM call)
     */
    quickComplexityCheck(task: string): { complexity: 'simple' | 'moderate' | 'complex'; agents: number } {
        const complexity = this.inferComplexity(task);
        
        const agentCounts = {
            simple: 2,
            moderate: 4,
            complex: 8,
        };

        return {
            complexity,
            agents: Math.min(agentCounts[complexity], this.maxAgents),
        };
    }
}

/**
 * Create a task decomposer instance
 */
export function createTaskDecomposer(provider: LLMProvider, maxAgents: number = 15): TaskDecomposer {
    return new TaskDecomposer(provider, maxAgents);
}
