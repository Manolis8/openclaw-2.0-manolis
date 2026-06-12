// ============================================
// SKILL TYPES
// ============================================

export interface Skill {
  id: string
  user_id: string
  skill_name: string
  skill_description: string
  execution_plan: ExecutionPlan
  plan_generated_at?: string
  plan_approved_at?: string
  status: 'draft' | 'approved' | 'active'
  is_public: boolean
  variables?: InputVariable[]
  created_at: string
  updated_at: string
}

export interface InputVariable {
  id: string
  skill_id: string
  variable_name: string
  variable_type: 'text' | 'number' | 'select' | 'checkbox'
  description?: string
  is_required: boolean
  default_value?: string
  created_at: string
}

export interface ExecutionPlan {
  steps: ExecutionStep[]
  variables: string[]
  estimatedTime: string
  errorHandling: ErrorHandlingStrategy
}

export interface ExecutionStep {
  number: number
  title: string
  action: 'navigate' | 'click' | 'type' | 'verify' | 'wait'
  url?: string
  selectors?: string[]
  fallbackSelectors?: string[]
  value?: string
  expected?: string
  timeout: number
  onError: 'retry' | 'pause' | 'abort'
  description: string
}

export interface ErrorHandlingStrategy {
  maxRetries: number
  pauseOnError: boolean
  userInterventionSteps: number[]
}

// ============================================
// EXECUTION TYPES
// ============================================

export interface SkillExecution {
  id: string
  skill_id: string
  user_id: string
  input_values: Record<string, string>
  status: 'running' | 'success' | 'error' | 'paused'
  execution_log: StepUpdate[]
  started_at: string
  completed_at?: string
  duration_seconds?: number
  error_message?: string
  final_url?: string
  created_at: string
}

export interface StepUpdate {
  stepNumber: number
  action: string
  status: 'running' | 'success' | 'error' | 'paused'
  duration?: number
  error?: string
  timestamp: string
}

// ============================================
// API RESPONSE TYPES
// ============================================

export interface CreatePlanResponse {
  plan: ExecutionPlan
  questions: ClarifyingQuestion[]
  inputs: InputVariable[]
}

export interface ClarifyingQuestion {
  question: string
  options: string[]
  type: 'yes_no' | 'multiple_choice'
}

export interface ExecutionResult {
  success: boolean
  log: StepUpdate[]
  finalUrl?: string
  errorMessage?: string
  durationMs: number
}

// ============================================
// DATABASE TYPES
// ============================================

export interface CreateSkillInput {
  skill_name: string
  skill_description: string
  execution_plan: ExecutionPlan
  status?: 'draft' | 'approved' | 'active'
  is_public?: boolean
}

export interface CreateInputVariableInput {
  variable_name: string
  variable_type: 'text' | 'number' | 'select' | 'checkbox'
  description?: string
  is_required: boolean
  default_value?: string
}
