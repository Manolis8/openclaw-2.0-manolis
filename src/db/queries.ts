import { supabase } from '../lib/supabase.js'
import {
  Skill,
  InputVariable,
  SkillExecution,
  StepUpdate,
  CreateSkillInput,
  CreateInputVariableInput
} from '../lib/types.js'

// ============================================
// SKILLS QUERIES
// ============================================

export async function saveSkill(
  userId: string,
  skill: CreateSkillInput
): Promise<Skill> {
  const { data, error } = await supabase
    .from('skills')
    .insert([
      {
        user_id: userId,
        skill_name: skill.skill_name,
        skill_description: skill.skill_description,
        execution_plan: skill.execution_plan,
        status: skill.status || 'active',
        is_public: skill.is_public || false,
        plan_approved_at: new Date().toISOString()
      }
    ])
    .select()
    .single()

  if (error) {
    throw new Error(`Failed to save skill: ${error.message}`)
  }

  return data
}

export async function getSkill(skillId: string): Promise<Skill | null> {
  const { data: skill, error: skillError } = await supabase
    .from('skills')
    .select('*')
    .eq('id', skillId)
    .single()

  if (skillError && skillError.code !== 'PGRST116') {
    throw new Error(`Failed to get skill: ${skillError.message}`)
  }

  if (!skill) return null

  const { data: variables, error: varError } = await supabase
    .from('skill_input_variables')
    .select('*')
    .eq('skill_id', skillId)

  if (varError) {
    console.error('Failed to get variables:', varError)
  }

  return {
    ...skill,
    variables: variables || []
  }
}

export async function listSkills(userId: string): Promise<Skill[]> {
  const { data, error } = await supabase
    .from('skills')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })

  if (error) {
    throw new Error(`Failed to list skills: ${error.message}`)
  }

  const skillsWithVariables = await Promise.all(
    (data || []).map(async (skill) => {
      const { data: variables } = await supabase
        .from('skill_input_variables')
        .select('*')
        .eq('skill_id', skill.id)

      return {
        ...skill,
        variables: variables || []
      }
    })
  )

  return skillsWithVariables
}

export async function updateSkill(
  skillId: string,
  updates: Partial<Skill>
): Promise<Skill> {
  const { data, error } = await supabase
    .from('skills')
    .update(updates)
    .eq('id', skillId)
    .select()
    .single()

  if (error) {
    throw new Error(`Failed to update skill: ${error.message}`)
  }

  return data
}

export async function deleteSkill(skillId: string): Promise<void> {
  const { error } = await supabase
    .from('skills')
    .delete()
    .eq('id', skillId)

  if (error) {
    throw new Error(`Failed to delete skill: ${error.message}`)
  }
}

// ============================================
// INPUT VARIABLES QUERIES
// ============================================

export async function saveInputVariable(
  skillId: string,
  variable: CreateInputVariableInput
): Promise<InputVariable> {
  const { data, error } = await supabase
    .from('skill_input_variables')
    .insert([
      {
        skill_id: skillId,
        variable_name: variable.variable_name,
        variable_type: variable.variable_type,
        description: variable.description,
        is_required: variable.is_required,
        default_value: variable.default_value
      }
    ])
    .select()
    .single()

  if (error) {
    throw new Error(`Failed to save variable: ${error.message}`)
  }

  return data
}

export async function getInputVariables(skillId: string): Promise<InputVariable[]> {
  const { data, error } = await supabase
    .from('skill_input_variables')
    .select('*')
    .eq('skill_id', skillId)

  if (error) {
    throw new Error(`Failed to get variables: ${error.message}`)
  }

  return data || []
}

// ============================================
// EXECUTIONS QUERIES
// ============================================

export async function createExecution(
  skillId: string,
  userId: string,
  inputValues: Record<string, string>
): Promise<SkillExecution> {
  const { data, error } = await supabase
    .from('skill_executions')
    .insert([
      {
        skill_id: skillId,
        user_id: userId,
        input_values: inputValues,
        status: 'running',
        execution_log: []
      }
    ])
    .select()
    .single()

  if (error) {
    throw new Error(`Failed to create execution: ${error.message}`)
  }

  return data
}

export async function getExecution(executionId: string): Promise<SkillExecution | null> {
  const { data, error } = await supabase
    .from('skill_executions')
    .select('*')
    .eq('id', executionId)
    .single()

  if (error && error.code !== 'PGRST116') {
    throw new Error(`Failed to get execution: ${error.message}`)
  }

  return data || null
}

export async function updateExecution(
  executionId: string,
  updates: Partial<SkillExecution>
): Promise<SkillExecution> {
  const { data, error } = await supabase
    .from('skill_executions')
    .update(updates)
    .eq('id', executionId)
    .select()
    .single()

  if (error) {
    throw new Error(`Failed to update execution: ${error.message}`)
  }

  return data
}

export async function appendExecutionLog(
  executionId: string,
  logEntry: StepUpdate
): Promise<void> {
  const execution = await getExecution(executionId)
  if (!execution) {
    throw new Error('Execution not found')
  }

  const updatedLog = [...(execution.execution_log || []), logEntry]

  await updateExecution(executionId, {
    execution_log: updatedLog
  })
}

export async function getExecutionHistory(
  skillId: string,
  limit = 50
): Promise<SkillExecution[]> {
  const { data, error } = await supabase
    .from('skill_executions')
    .select('*')
    .eq('skill_id', skillId)
    .order('started_at', { ascending: false })
    .limit(limit)

  if (error) {
    throw new Error(`Failed to get execution history: ${error.message}`)
  }

  return data || []
}
