const fs = require('fs');
const orval = require('orval');

const swaggerEndpoint = "http://localhost:3000/swagger-json";
const swaggerFile = "./scripts/sdk-gen/swagger.json";

const orvalConfig = {
    input: {
        target: swaggerFile,
    },
    output: {
        mode: 'single',
        target: './src/indexer-sdk/indexer-api.ts',
        schemas: './src/indexer-sdk/model',
        client: 'fetch',
        mock: false,
        override: {
            mutator: {
                path: "./src/indexer-sdk/http-client/http-client.ts",
                name: "customFetch",
            },
        },
    }
};

run(orvalConfig, swaggerFile);

async function run(orvalConfig, swaggerFile) {
    const response = await fetch(swaggerEndpoint);
    if (!response.ok) {
        throw new Error(`Response status: ${response.status}`);
    }
    const json = await response.json();
    fs.writeFileSync(swaggerFile, JSON.stringify(json, null, 2));
    await orval.generate(orvalConfig);
}
