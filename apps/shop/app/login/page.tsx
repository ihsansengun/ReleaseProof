import { loginAction } from "../actions";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <>
      <h1>Sign in</h1>
      {error && (
        <p role="alert" className="notice error">
          Email or password is incorrect.
        </p>
      )}
      <form action={loginAction}>
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" required />
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" required />
        <p>
          <button type="submit">Sign in</button>
        </p>
      </form>
    </>
  );
}
