export const signOutFromServerProfile = async (
  apiOrigin: string,
): Promise<void> => {
  await fetch(`${apiOrigin}/api/auth/sign-out`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
  });
};

export const updateUserName = async (
  apiOrigin: string,
  name: string,
): Promise<boolean> => {
  const response = await fetch(`${apiOrigin}/api/auth/update-user`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return response.ok;
};
