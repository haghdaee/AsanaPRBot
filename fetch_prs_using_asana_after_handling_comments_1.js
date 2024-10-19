import express from 'express';
import { Octokit } from '@octokit/rest';
import OpenAI from 'openai';
import fetch from 'node-fetch'; // Ensure this is installed: npm install node-fetch
import crypto from 'crypto';

const {
  ASANA_PERSONAL_ACCESS_TOKEN,
  GITHUB_TOKEN,
  OPENAI_API_KEY,
  PORT = 3000,
} = process.env;

const app = express();
app.use(express.json()); // Parse JSON bodies

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

// Function to get the authenticated GitHub user's username
async function getGitHubBotUsername(octokit) {
  const { data: authenticatedUser } = await octokit.users.getAuthenticated();
  return authenticatedUser.login;
}

// Route to handle Asana webhooks
app.post('/webhook', async (req, res) => {
  // Handle Asana webhook verification
  console.log('Received Asana webhook event.');
  const xHookSecret = req.headers['x-hook-secret'];
  if (xHookSecret) {
    console.log('Verifying Asana webhook...');
    res.set('X-Hook-Secret', xHookSecret);
    return res.status(200).send();
  }

  const events = req.body.events;
  if (!events || events.length === 0) {
    console.log('No events to process.');
    return res.status(200).send('No events to process.');
  }

  // Process each event
  for (const event of events) {
    console.log('Processing event:', JSON.stringify(event));
    const resource = event.resource;
    if (resource.resource_type === 'task' && event.action === 'added') {
      // Handle new tasks
      await processAsanaTask(resource.gid);
    } else if (resource.resource_type === 'story' && event.action === 'added' && resource.resource_subtype === 'comment_added') {
      // Handle new comments
      await processAsanaStory(resource.gid);
    } else {
      console.log('Ignoring event:', JSON.stringify(event));
    }
  }

  res.status(200).send('Events processed.');
});

// Function to process the Asana story (comment)
async function processAsanaStory(storyId) {
  console.log(`Processing Asana Story #${storyId}...\n`);

  try {
    // Fetch story details from Asana API
    const storyDetails = await getAsanaStoryDetails(storyId);

    // Check if the story is a comment
    if (storyDetails.type !== 'comment') {
      console.log('Story is not a comment. Skipping.');
      return;
    }

    const commentText = storyDetails.text;

    // Check if the comment contains "@AsanaAI"
    if (!commentText.includes('@AsanaAI')) {
      console.log('Comment does not contain @AsanaAI. Skipping.');
      return;
    }

    // Get the task ID the story is associated with
    const taskId = storyDetails.target.gid;

    // Fetch task details from Asana
    const taskDetails = await getAsanaTaskDetails(taskId);

    // Now process the task, passing the comment text as context
    await processAsanaTask(taskId, commentText);
  } catch (error) {
    console.error(`Error processing Asana Story #${storyId}:`, error);
  }
}

// Function to fetch Asana story details
async function getAsanaStoryDetails(storyId) {
  const response = await fetch(`https://app.asana.com/api/1.0/stories/${storyId}`, {
    headers: {
      'Authorization': `Bearer ${ASANA_PERSONAL_ACCESS_TOKEN}`,
    },
  });
  const data = await response.json();
  return data.data;
}

// Function to process the Asana task
async function processAsanaTask(taskId, context = null) {
  console.log(`Processing Asana Task #${taskId}...\n`);

  try {
    // Fetch task details from Asana API
    const taskDetails = await getAsanaTaskDetails(taskId);

    // Check if task has already been processed
    const processedTag = 'AsanaAI Processed';
    const taskTags = taskDetails.tags.map(tag => tag.name);

    if (taskTags.includes(processedTag)) {
      console.log(`Task #${taskId} has already been processed. Skipping.`);
      return;
    }

    // Extract the PR URL from the task description or custom fields
    const prUrl = extractPrUrlFromTask(taskDetails);

    if (!prUrl) {
      console.log('No PR URL found in the task.');
      return;
    }

    // Extract owner, repo, and PR number from the URL
    const { owner, repo, prNumber } = parseGithubUrl(prUrl);

    if (!owner || !repo || !prNumber) {
      console.log('Invalid PR URL.');
      return;
    }

    // Process the PR
    await processPullRequest(prNumber, owner, repo, context);

    // After processing, add the 'AsanaAI Processed' tag to the task
    await addTagToTask(taskId, processedTag);

  } catch (error) {
    console.error(`Error processing Asana Task #${taskId}:`, error);
  }
}

// Function to fetch Asana task details
async function getAsanaTaskDetails(taskId) {
  const response = await fetch(`https://app.asana.com/api/1.0/tasks/${taskId}?opt_fields=tags,workspace,notes`, {
    headers: {
      'Authorization': `Bearer ${ASANA_PERSONAL_ACCESS_TOKEN}`,
    },
  });
  const data = await response.json();
  return data.data;
}

// Function to extract PR URL from the task
function extractPrUrlFromTask(taskDetails) {
  // Assuming the PR URL is in the task description
  const description = taskDetails.notes;
  const prUrlMatch = description.match(/https:\/\/github\.com\/[^\s]+/);
  if (prUrlMatch) {
    return prUrlMatch[0];
  }
  return null;
}

// Function to parse the PR URL
function parseGithubUrl(url) {
  const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/);
  if (match) {
    const [, owner, repo, prNumber] = match;
    return { owner, repo, prNumber };
  }
  return {};
}

// Function to process a single PR
async function processPullRequest(prNumber, owner, repo, context = null) {
  console.log(`Processing PR #${prNumber} in ${owner}/${repo}...\n`);

  try {
    // Authenticate with GitHub
    const octokit = new Octokit({ auth: GITHUB_TOKEN });
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

    // Fetch the bot's GitHub username
    const botUsername = await getGitHubBotUsername(octokit);

    // Fetch PR details
    const { data: pr } = await octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    // Check if the bot has already commented on the PR
    const { data: comments } = await octokit.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
    });

    const botCommentExists = comments.some(
      (comment) => comment.user.login === botUsername
    );

    if (botCommentExists) {
      console.log(`Bot has already commented on PR #${prNumber}. Skipping.`);
      return;
    }

    // Compile the prompt
    let prompt = "";

    // Summary
    const summary = `### Pull Request #${pr.number}: ${pr.title}

**Description:**
${pr.body || "No description provided."}

`;

    // Diff
    const { data: diff } = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        owner,
        repo,
        pull_number: prNumber,
        headers: {
          accept: "application/vnd.github.v3.diff",
        },
      }
    );

    const diffContent = `**Diff:**
\`\`\`diff
${diff}
\`\`\`

`;

    // Contextual Background
    const reviewers = pr.requested_reviewers.map((reviewer) => reviewer.login);
    const assignees = pr.assignees.map((assignee) => assignee.login);

    const contextSection = `**Labels:** ${pr.labels.map((label) => label.name).join(", ") || "None"}
**Assignees:** ${assignees.join(", ") || "None"}
**Reviewers:** ${reviewers.join(", ") || "None"}

`;

    // Comments (excluding bot comments)
    const humanComments = comments.filter(
      (comment) => comment.user.type !== "Bot" && comment.user.login !== botUsername
    );

    const commentsList = humanComments
      .map((comment) => `- **${comment.user.login}:** ${comment.body}`)
      .join("\n");

    const commentsSection = commentsList
      ? `**Comments:**
${commentsList}

`
      : "";

    // Additional Context from Asana
    const asanaContext = context
      ? `**Additional Context from Asana:**
${context}

`
      : "";

    // Compile the prompt for this PR
    prompt += `${summary}${diffContent}${contextSection}${commentsSection}${asanaContext}\n---\n\n`;

    // Final prompt to be provided to the assistant
    const finalPrompt = `I have the following pull request that I'd like feedback on. Please review the information and provide your insights.

${prompt}
Please focus on any potential issues, improvements, or suggestions you might have. Be succinct and clear in your feedback.
If you have any questions or need more information, feel free to ask. If the PR is ready to merge, please indicate that as well.
If you see that the PR addresses disparate issues that are best addressed in separate, nudge the author to split the PR into smaller, more focused PRs, using Graphite.
`;

    // Send the prompt to OpenAI
    const completion = await openai.chat.completions.create({
      model: "o1-preview", // Use "gpt-3.5-turbo" if necessary
      messages: [
        { role: "user", content: finalPrompt },
      ],
    });

    const aiResponse = completion.choices[0].message.content;

    // Post the AI response as a comment on the PR
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: aiResponse,
    });

    console.log(`Comment posted to PR #${prNumber}`);
  } catch (error) {
    console.error(`Error processing PR #${prNumber}:`, error);
  }
}

// Function to add a tag to a task
async function addTagToTask(taskId, tagName) {
  // Fetch task details to get the workspace ID
  const taskDetails = await getAsanaTaskDetails(taskId);
  const workspaceId = taskDetails.workspace.gid;

  // Search for the tag in the workspace
  let tag = await findTagInWorkspace(workspaceId, tagName);

  if (!tag) {
    // Create the tag
    tag = await createTagInWorkspace(workspaceId, tagName);
  }

  // Add the tag to the task
  await attachTagToTask(taskId, tag.gid);
}

// Function to find a tag in a workspace
async function findTagInWorkspace(workspaceId, tagName) {
  const response = await fetch(`https://app.asana.com/api/1.0/workspaces/${workspaceId}/tags?opt_fields=name`, {
    headers: {
      'Authorization': `Bearer ${ASANA_PERSONAL_ACCESS_TOKEN}`,
    },
  });
  const data = await response.json();

  const tag = data.data.find(t => t.name === tagName);

  return tag;
}

// Function to create a tag in a workspace
async function createTagInWorkspace(workspaceId, tagName) {
  const response = await fetch(`https://app.asana.com/api/1.0/tags`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ASANA_PERSONAL_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      data: {
        name: tagName,
        workspace: workspaceId,
      },
    }),
  });
  const data = await response.json();
  return data.data;
}

// Function to attach a tag to a task
async function attachTagToTask(taskId, tagId) {
  await fetch(`https://app.asana.com/api/1.0/tasks/${taskId}/addTag`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ASANA_PERSONAL_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      data: {
        tag: tagId,
      },
    }),
  });
}
