const eslintConfig = [
  {
    ignores: [
      "dist/**",
      "dist-demo/**",
      "dist-staging/**",
      "node_modules/**",
      "cloudflare-env.d.ts",
      "src/routeTree.gen.ts",
    ],
  },
];

export default eslintConfig;
