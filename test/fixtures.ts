// Fixtures modelled on what VS Code + GitHub Copilot Chat write to disk.
export const agentRequest = {
	requestId: 'request_1',
	timestamp: 1764000000000,
	modelId: 'copilot/gpt-5',
	modeInfo: { kind: 'agent', modeId: 'agent' },
	message: { text: 'Fix the failing test in utils.ts', parts: [] },
	variableData: { variables: [] },
	response: [
		{ value: 'I will look at the file first.', supportThemeIcons: false },
		{
			kind: 'toolInvocationSerialized',
			toolId: 'copilot_readFile',
			toolCallId: 'call_read',
			invocationMessage: { value: 'Reading utils.ts' },
			pastTenseMessage: { value: 'Read utils.ts' },
			isComplete: true,
			isConfirmed: { type: 1 },
		},
		{
			kind: 'toolInvocationSerialized',
			toolId: 'run_in_terminal',
			toolCallId: 'call_term',
			invocationMessage: 'Running npm test',
			isComplete: true,
			toolSpecificData: { kind: 'terminal', commandLine: { original: 'npm test' }, terminalCommandOutput: { text: 'TERMINAL OUTPUT' } },
		},
		{ value: 'Fixed it.' },
	],
	result: {
		timings: { firstProgress: 100, totalElapsed: 2000 },
		metadata: {
			toolCallRounds: [
				{
					id: 'round_1',
					response: 'I will look at the file first.',
					toolCalls: [{ id: 'call_read', name: 'copilot_readFile', arguments: '{"filePath":"/home/alice/proj/utils.ts"}' }],
					thinking: { id: 't1', text: ['Need to ', 'read the file.'] },
					timestamp: 1764000001000,
				},
				{
					id: 'round_2',
					response: '',
					toolCalls: [{ id: 'call_term', name: 'run_in_terminal', arguments: '{"command":"npm test"}' }],
					timestamp: 1764000002000,
				},
				{ id: 'round_3', response: 'Fixed it.', toolCalls: [], timestamp: 1764000003000 },
			],
			toolCallResults: {
				call_read: { $mid: 20, content: [{ $mid: 21, value: 'export const add = (a, b) => a - b; // token hf_abcdefghijklmnopqrstuvwxyz0123456789' }] },
				call_term: {
					$mid: 20,
					content: [{ $mid: 22, value: { node: { type: 1, ctor: 2, ctorName: 'X', children: [{ type: 2, text: '1 passing', priority: 1 }, { type: 2, text: '0 failing', lineBreakBefore: true }] } } }],
				},
			},
		},
	},
	responseTimestamp: 1764000003500,
};

export const askRequest = {
	requestId: 'request_2',
	timestamp: 1764000010000,
	modelId: 'copilot/claude-sonnet-4.5',
	message: { text: 'What does `add` do?', parts: [] },
	response: [
		{ kind: 'thinking', value: 'Simple question.' },
		{ value: 'It adds two numbers, see ' },
		{ kind: 'inlineReference', inlineReference: { $mid: 1, scheme: 'file', path: '/home/alice/proj/utils.ts' } },
		{
			kind: 'toolInvocationSerialized',
			toolId: 'copilot_findFiles',
			toolCallId: 'tc9',
			invocationMessage: 'Searching',
			resultDetails: { input: '{"query":"**/*.ts"}', output: [{ type: 'embed', value: 'utils.ts\nindex.ts', isText: true }] },
			isComplete: true,
		},
		{ value: 'Done.' },
	],
	result: { metadata: {} },
	responseTimestamp: 1764000011000,
};

export const legacySession = {
	version: 3,
	sessionId: 'sess-legacy',
	creationDate: 1764000000000,
	lastMessageDate: 1764000011000,
	requesterUsername: 'alice',
	responderUsername: 'GitHub Copilot',
	initialLocation: 'panel',
	requests: [agentRequest, askRequest],
};

/** Same session as an operation log, the way VS Code >= 1.10x writes it. */
export function operationLog(): string {
	const initial = { ...legacySession, customTitle: undefined, requests: [] as unknown[] };
	const lines = [
		{ kind: 0, v: initial },
		{ kind: 2, k: ['requests'], v: [{ ...agentRequest, response: [], result: undefined }] },
		{ kind: 2, k: ['requests', 0, 'response'], v: agentRequest.response.slice(0, 2) },
		{ kind: 2, k: ['requests', 0, 'response'], v: agentRequest.response.slice(2), i: 2 },
		{ kind: 1, k: ['requests', 0, 'result'], v: agentRequest.result },
		{ kind: 2, k: ['requests'], v: [askRequest] },
		{ kind: 1, k: ['customTitle'], v: 'Fixing utils test' },
		{ kind: 2, k: ['requests'], v: [{ requestId: 'tmp', message: { text: 'discarded' }, response: [] }] },
		{ kind: 2, k: ['requests'], v: [], i: 2 }, // splice away the discarded request
		{ kind: 3, k: ['requesterUsername'] },
	];
	return lines.map(l => JSON.stringify(l)).join('\n') + '\n{"kind":1,"k":["torn"'; // torn last line
}
