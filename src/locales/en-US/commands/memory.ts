export default {
  memory: {
    description: `Manage stored memories and documents.`,
    document: {
      description: `Manage document memories.`,
      add: {
        description: `Add a document to memory.`,
      },
      remove: {
        description: `Remove a document from memory.`,
      },
    },
    personal: {
      description: `Manage personal memories.`,
      add: {
        description: `Add a personal memory.`,
      },
      remove: {
        description: `Remove a personal memory.`,
      },
      "admin-edit": {
        description: `[Bot Owner] Edit another user's personal memory.`,
        member_description: `The user whose personal memory you want to edit.`,
        scope_description: `Choose whether to edit persona-scoped or global memories.`,
        scope_choice_persona: `Persona`,
        scope_choice_global: `Global`,
        target_is_bot_title: `Cannot Target a Bot`,
        target_is_bot_description: `Bots don't have personal memories.`,
        target_not_found_title: `User Not Found`,
        target_not_found_description: `{user_mention} hasn't interacted with me yet, so they have no stored data.`,
        no_memories_title: `No Personal Memories`,
        no_memories_description: `{user_mention} doesn't have any personal memories stored in this scope.`,
        select_modal_title: `Select Personal Memory`,
        select_label: `Memory to Edit`,
        select_description: `Choose which personal memory to edit`,
        select_placeholder: `Select a memory...`,
        confirm_title: `Edit Personal Memory?`,
        confirm_description: `You selected this personal memory belonging to {user_mention}:
> {memory}

Click **Confirm** to edit it.`,
        modal_title: `Edit Personal Memory`,
        memory_input_label: `Updated Personal Memory`,
        memory_input_description: `Replace the selected personal memory with new text.`,
        memory_input_placeholder: `{user} likes mango floats`,
        no_changes_title: `No Changes Made`,
        no_changes_description: `That personal memory is already set to this text.`,
        duplicate_title: `Duplicate Personal Memory`,
        duplicate_description: `This memory '{memory}' is already in this user's personal memories.`,
        success_title: `Personal Memory Updated`,
        success_description: `Successfully updated {user_mention}'s personal memory to: "{memory}"`,
      },
      "admin-remove": {
        description: `[Bot Owner] Remove another user's personal memory.`,
        member_description: `The user whose personal memory you want to remove.`,
        scope_description: `Choose whether to remove persona-scoped or global memories.`,
        scope_choice_persona: `Persona`,
        scope_choice_global: `Global`,
        target_is_bot_title: `Cannot Target a Bot`,
        target_is_bot_description: `Bots don't have personal memories.`,
        target_not_found_title: `User Not Found`,
        target_not_found_description: `{user_mention} hasn't interacted with me yet, so they have no stored data.`,
        no_memories_title: `No Personal Memories`,
        no_memories_description: `{user_mention} doesn't have any personal memories stored in this scope.`,
        modal_title: `Remove Personal Memory`,
        select_label: `Memory to Remove`,
        select_description: `Choose which personal memory to remove`,
        select_placeholder: `Select a memory...`,
        success_title: `Personal Memory Removed`,
        success_description: `Successfully removed {user_mention}'s personal memory: "{memory}"`,
      },
    },
    server: {
      description: `Manage server memories.`,
      add: {
        description: `Add a server memory.`,
      },
      remove: {
        description: `Remove a server memory.`,
      },
    },
  },
};
